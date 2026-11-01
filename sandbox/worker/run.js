import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { JOB_TOKEN, ORCHESTRATOR_URL, MAX_RUNTIME_SEC = "900" } = process.env;
const ROOT = "/work/repo";
let ghToken = "";
let svcEnv = {};
let reported = false;

const scrub = (s) => {
  let t = String(s);
  for (const v of [ghToken, ...Object.values(svcEnv)]) if (v) t = t.split(v).join("***");
  return t;
};
const tail = (s, n = 2500) => (s.length > n ? "[...]" + s.slice(-n) : s);
const trunc = (s, n = 3000) => (s.length > n ? s.slice(0, n / 2) + "\n...[tronqué]...\n" + s.slice(-n / 2) : s);

async function api(p, opts = {}) {
  const r = await fetch(ORCHESTRATOR_URL + p, {
    ...opts,
    headers: { Authorization: `Bearer ${JOB_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(150000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} ${r.status} ${t.slice(0, 400)}`);
  return JSON.parse(t);
}

// Journal d'activité : chaque action est envoyée à l'orchestrateur, que get_job montre à l'utilisateur.
// Sans conséquence si l'envoi échoue.
const progress = (line) => {
  api("/internal/progress", { method: "POST", body: JSON.stringify({ line: scrub(line).slice(0, 200) }) }).catch(() => {});
};

async function report(body) {
  if (reported) return;
  reported = true;
  try {
    await api("/internal/result", { method: "POST", body: JSON.stringify({ ...body, summary: scrub(body.summary || "") }) });
  } catch (err) {
    console.error("report:", scrub(err.message));
  }
}

setTimeout(async () => {
  await report({ status: "failed", summary: "Délai maximum dépassé." });
  process.exit(1);
}, Number(MAX_RUNTIME_SEC) * 1000);

// ------------------------------------------------------------------ git / GitHub
const authHeader = () => "AUTHORIZATION: basic " + Buffer.from(`x-access-token:${ghToken}`).toString("base64");
const git = (args, cwd = ROOT) =>
  execFileSync("git", ["-c", `http.https://github.com/.extraheader=${authHeader()}`, "-c", "user.name=AI Fix Bot", "-c", "user.email=ai-fix-bot@users.noreply.github.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
const gh = (p, opts = {}) =>
  fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "User-Agent": "fly-sandbox-worker", "Content-Type": "application/json" },
  });

// ------------------------------------------------------------------ exécution de commandes
// Environnement réduit : ni jeton GitHub, ni jeton de tâche. Seules les clés de services de l'utilisateur sont présentes.
const sh = (command, timeout = 120000) => {
  const r = spawnSync("bash", ["-lc", command], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 5e6,
    env: { PATH: process.env.PATH, HOME: "/home/worker", CI: "1", ...svcEnv },
  });
  return { code: r.status ?? "timeout", out: `${r.stdout || ""}${r.stderr || ""}` };
};

// Démarrage de l'application (16 s au plus) : le terminal lance « npm start », cherche la page sur les ports usuels,
// vérifie le code HTTP, ouvre la page dans un vrai navigateur (chromium headless) et relève les erreurs de la console.
// Échec = plantage au démarrage, erreur fatale dans le journal, HTTP 5xx ou erreur JavaScript dans la page.
// Une application qui reste lancée sans page (bot, worker) est acceptée.
const SMOKE = "{\n" + String.raw`L=$(mktemp); D=$(mktemp); K=$(mktemp); H=""
PORT=3000 timeout -k 2 16 npm start > "$L" 2>&1 &
P=$!
URL=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  kill -0 $P 2>/dev/null || break
  for p in 3000 8080 5173 4173 8000; do
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/"; then URL="http://127.0.0.1:$p/"; break 2; fi
  done
done
if [ -n "$URL" ]; then
  H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL")
  echo "--- page $URL : code HTTP $H ---"
  C=$(command -v chromium || command -v chromium-browser)
  if [ -n "$C" ]; then
    timeout 25 "$C" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --enable-logging=stderr --v=0 --virtual-time-budget=5000 --dump-dom "$URL" > "$D" 2> "$K"
    echo "--- navigateur : page de $(wc -c < "$D") octets, erreurs de la console : ---"
    grep 'CONSOLE' "$K" | head -5 | cut -c1-300
  fi
  kill $P 2>/dev/null; wait $P 2>/dev/null; c=124
else
  wait $P; c=$?
fi
echo "--- démarrage de l'application (npm start) ---"
tail -c 2000 "$L"
bad=0
case "$H" in 5*) bad=1;; esac
grep -Eq 'CONSOLE.*(Uncaught|Error)' "$K" && bad=1
if [ $c -eq 124 ]; then grep -Eq 'EADDRINUSE|Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|UnhandledPromiseRejection|Error: listen|TypeError' "$L" && bad=1; exit $bad; fi
exit $c` + "\n}";

// Vérification du projet (test ou build). Le terminal la relance LUI-MÊME après chaque fichier modifié :
// l'IA ne la relance pas et reçoit l'erreur exacte telle quelle.
// failedAtStart : la vérification échouait au départ (sinon rien à réparer, pas de fin automatique).
let CHECK = null;
let PLAN = [];
let TIER = "aube"; // « soleil » : un expert (modèle fort) peut conseiller l'agent quand il est bloqué
let LAST_OUT = ""; // dernière sortie de vérification (donnée à l'expert)
const TRIED = []; // dernières actions de l'agent (données à l'expert)

// Vérifications automatiques : l'IA part des ERREURS, elle ne lit pas tout le projet.
function autoChecks() {
  const has = (f) => fs.existsSync(path.join(ROOT, f));
  if (has("package.json")) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {}; } catch {}
    const inst = sh(has("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund", 240000);
    if (inst.code !== 0) return `installation npm échouée (code ${inst.code}) :\n${tail(inst.out)}`;
    const cmd = scripts.test && !/no test specified/.test(scripts.test) ? "npm test" : scripts.build ? "npm run build" : null;
    if (!cmd && !scripts.start) return "Aucun script de test, de build ou de démarrage.";
    // Démarrage de l'application (voir SMOKE) : lancée après le test ou le build, page ouverte dans un navigateur.
    const parts = [];
    if (cmd) parts.push(`${cmd} 2>&1`);
    if (scripts.start) {
      if (scripts.build && cmd !== "npm run build") parts.push("npm run build 2>&1");
      parts.push(SMOKE);
    }
    const label = [cmd, scripts.start ? "démarrage" : null].filter(Boolean).join(" + ");
    const command = parts.join(" && ");
    const r = sh(command, 280000);
    CHECK = { label, command, failedAtStart: r.code !== 0 };
    LAST_OUT = r.out;
    return `${label} -> code ${r.code}\n${tail(r.out)}`;
  }
  if (has("requirements.txt") || has("pyproject.toml")) {
    const r = sh("python3 -m pytest -x -q 2>&1", 240000);
    CHECK = { label: "pytest", command: "python3 -m pytest -x -q 2>&1", failedAtStart: r.code !== 0 };
    LAST_OUT = r.out;
    return `pytest -> code ${r.code}\n${tail(r.out)}`;
  }
  return "Aucune vérification automatique détectée.";
}

// ------------------------------------------------------------------ outils de l'agent
const safe = (p) => {
  const full = path.resolve(ROOT, p || ".");
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error("chemin hors du dépôt");
  if (full.split(path.sep).includes(".git")) throw new Error(".git interdit");
  return full;
};

// Extraits des fichiers cités par l'erreur de départ (2 fichiers, ~30 lignes chacun) : donnés à l'IA dès la
// première étape, pour qu'elle n'ait pas à les demander (chaque aller-retour renvoie tout l'historique).
function errorContext(out, maxFiles = 2, radius = 15) {
  const found = new Map();
  const re = /((?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|jsx|tsx|js|ts|py|json|css|html|vue|go|rb|php))(?:["']?[:(,]\s*(?:line\s*)?(\d+))?/g;
  let m;
  while ((m = re.exec(out)) && found.size < maxFiles) {
    const rel = m[1].replace(/^\.\//, "").replace(/^work\/repo\//, "");
    if (found.has(rel) || rel.includes("node_modules") || /(^|\/)package-lock\.json$/.test(rel)) continue;
    try {
      const st = fs.statSync(safe(rel));
      if (!st.isFile() || st.size > 400000) continue;
    } catch {
      continue;
    }
    found.set(rel, m[2] ? Number(m[2]) : 1);
  }
  let text = "";
  for (const [rel, line] of found) {
    const lines = fs.readFileSync(safe(rel), "utf8").split("\n");
    const a = Math.max(1, line - radius);
    const b = Math.min(lines.length, line + radius);
    text += `\n--- ${rel} (lignes ${a}-${b} sur ${lines.length}) ---\n` + lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l.slice(0, 200)}`).join("\n");
  }
  return text.length > 5000 ? text.slice(0, 5000) + "\n[...]" : text;
}

// Soleil : demande des instructions à l'expert (modèle fort). Il reçoit peu de texte : l'erreur, les extraits
// des fichiers cités et les dernières actions, jamais l'historique entier.
async function askExpert(question) {
  let excerpts = "";
  try {
    excerpts = LAST_OUT ? errorContext(LAST_OUT) : "";
  } catch {}
  const context = [
    LAST_OUT ? `Fin de la dernière vérification :\n${tail(scrub(LAST_OUT), 2500)}` : "",
    excerpts ? `Extraits des fichiers cités :${excerpts}` : "",
    TRIED.length ? `Dernières actions de l'agent :\n${TRIED.slice(-10).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  progress("Consultation de l'expert (Claude)");
  const r = await api("/internal/llm/expert", { method: "POST", body: JSON.stringify({ question, context }) });
  progress("L'expert a répondu");
  return String(r.advice || "");
}

const tools = {
  async ask_expert({ question }) {
    if (TIER !== "soleil") throw new Error("expert indisponible avec ce modèle");
    return trunc(scrub(await askExpert(String(question || "Je suis bloqué, aide-moi.").slice(0, 1500))), 4000);
  },
  list_files({ dir = "." }) {
    const base = path.relative(ROOT, safe(dir));
    const files = git(["ls-files"]).split("\n").filter((f) => f && (!base || f.startsWith(base + "/") || f === base));
    return files.slice(0, 200).join("\n") + (files.length > 200 ? `\n... (${files.length} fichiers)` : "");
  },
  read_file({ path: p, start = 1, end = 120 }) {
    const lines = fs.readFileSync(safe(p), "utf8").split("\n");
    const a = Math.max(start, 1);
    const b = Math.min(end, a + 119, lines.length);
    return lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join("\n") + `\n[lignes ${a}-${b} sur ${lines.length}]`;
  },
  write_file({ path: p, content }) {
    const full = safe(p);
    if (path.relative(ROOT, full).startsWith(".github")) throw new Error("modification de .github interdite");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return `écrit : ${p}`;
  },
  // Recherche dans le code suivi par git (expression régulière) : trouve où quelque chose est défini ou utilisé
  // sans lire des fichiers entiers.
  search_code({ pattern, dir = "." }) {
    if (typeof pattern !== "string" || !pattern) throw new Error("pattern est vide");
    const base = path.relative(ROOT, safe(dir)) || ".";
    const r = spawnSync("git", ["grep", "-n", "-I", "-E", "--max-count=5", "-e", pattern, "--", base], { cwd: ROOT, encoding: "utf8", timeout: 20000, maxBuffer: 2e6 });
    if (r.status > 1) throw new Error(`recherche impossible : ${String(r.stderr || "").slice(0, 200)}`);
    const lines = (r.stdout || "").split("\n").filter(Boolean);
    if (!lines.length) return "aucun résultat";
    return lines.slice(0, 40).map((l) => l.slice(0, 200)).join("\n") + (lines.length > 40 ? `\n... (${lines.length} résultats, affine ta recherche)` : "");
  },
  // Retouche : remplace UN extrait exact par un autre. Bien moins de tokens que réécrire le fichier entier.
  edit_file({ path: p, old_str, new_str }) {
    const full = safe(p);
    if (path.relative(ROOT, full).startsWith(".github")) throw new Error("modification de .github interdite");
    if (typeof old_str !== "string" || !old_str) throw new Error("old_str est vide");
    const src = fs.readFileSync(full, "utf8");
    const n = src.split(old_str).length - 1;
    if (n === 0) throw new Error("old_str introuvable : relis le fichier avec read_file et recopie l'extrait exactement (espaces compris)");
    if (n > 1) throw new Error(`old_str apparaît ${n} fois : ajoute des lignes autour pour qu'il soit unique`);
    fs.writeFileSync(full, src.replace(old_str, () => String(new_str ?? "")));
    return `modifié : ${p}`;
  },
  // Plan : quelques étapes courtes, affichées à l'utilisateur et rappelées après chaque vérification.
  plan({ steps }) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("steps doit être une liste d'étapes");
    PLAN = steps.slice(0, 8).map((x) => String(x).slice(0, 100));
    progress("Plan : " + PLAN.map((x, i) => `${i + 1}. ${x}`).join(" | "));
    return "plan enregistré";
  },
  // Vérification à la demande (nouveau projet) : installation, test ou build, démarrage et page dans un navigateur.
  verify() {
    progress("Vérification : installation, build, démarrage, page");
    if (CHECK) {
      const r = sh(CHECK.command, 280000);
      return trunc(scrub(`${CHECK.label} -> code ${r.code}\n${tail(r.out)}`));
    }
    return trunc(scrub(autoChecks()));
  },
  run({ command }) {
    const r = sh(command);
    progress(`commande terminée (code ${r.code})`);
    return trunc(`code ${r.code}\n${r.out}`);
  },
};

const T = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const toolDefs = [
  T("list_files", "Liste les fichiers suivis par git (200 max).", { dir: { type: "string" } }, []),
  T("read_file", "Lit un fichier, 120 lignes max par appel.", { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, ["path"]),
  T("search_code", "Cherche une expression régulière dans les fichiers du projet (40 lignes max). À utiliser pour trouver où une fonction, une variable ou un message est défini ou utilisé, au lieu de lire des fichiers entiers.", { pattern: { type: "string" }, dir: { type: "string" } }, ["pattern"]),
  T("edit_file", "Modifie un fichier EXISTANT : remplace un court extrait exact (old_str, unique dans le fichier) par new_str. À utiliser pour toute correction. Le terminal relance ensuite la vérification tout seul et te donne le résultat.", { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } }, ["path", "old_str", "new_str"]),
  T("write_file", "Crée un NOUVEAU fichier avec son contenu complet. Ne l'utilise pas pour modifier un fichier existant (utilise edit_file). Le terminal relance ensuite la vérification tout seul.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  T("plan", "Enregistre ton plan : 3 à 6 étapes courtes, dans l'ordre. À faire en premier pour un nouveau projet ou une tâche de plusieurs fichiers.", { steps: { type: "array", items: { type: "string" } } }, ["steps"]),
  T("verify", "Lance maintenant la vérification complète du projet : installation, test ou build, démarrage de l'application et ouverture de la page dans un navigateur. À appeler quand les fichiers du projet sont écrits. Ensuite le terminal la relance tout seul après chaque fichier modifié.", {}, []),
  T("ask_expert", "Demande des instructions précises à un expert (modèle plus fort). À utiliser seulement si tu es bloqué après deux essais sur la même erreur : 3 fois au plus par tâche. Décris le blocage en une ou deux phrases ; l'erreur et les extraits sont ajoutés automatiquement. Applique ensuite ses instructions avec edit_file.", { question: { type: "string" } }, ["question"]),
  T("run", "Exécute une commande shell dans le projet (120 s max) : vercel, wrangler, fly, curl, ou toute autre commande utile. Inutile pour relancer le test ou le build : le terminal le fait seul.", { command: { type: "string" } }, ["command"]),
  T("note", "Écrit une courte ligne visible par l'utilisateur dans le suivi (ex. « Erreur 1 corrigée : ... », « Je passe à l'erreur 2 »).", { text: { type: "string" } }, ["text"]),
  T("finish", "Termine la tâche avec un court résumé en deux parties : Corrigé et Reste à faire.", { summary: { type: "string" } }, ["summary"]),
];

const SOLEIL_NOTE = " Tu disposes aussi de l'outil ask_expert : si tu es bloqué après deux essais sur la même erreur, appelle-le (3 fois au plus) et applique ses instructions à la lettre avec edit_file. Ne l'appelle pas pour une erreur que tu peux régler toi-même.";
const SYSTEM = `Tu es un agent de développement dans un conteneur Linux jetable, avec un projet git cloné. Les vérifications automatiques ont déjà été lancées : pars de leurs ERREURS, ne lis que les fichiers cités, ne lis jamais le projet entier. S'il y a plusieurs erreurs, corrige-les UNE À LA FOIS, dans l'ordre : une seule erreur par modification. Les extraits des fichiers cités par l'erreur te sont déjà donnés : ne les relis pas. Pour trouver où quelque chose est défini ou utilisé, utilise search_code plutôt que de lire des fichiers entiers. Pour modifier un fichier existant, utilise edit_file (remplace un court extrait exact) ; write_file sert seulement à créer un nouveau fichier. Ne réécris jamais un fichier entier pour changer quelques lignes. Après chaque fichier modifié, le terminal relance LUI-MÊME la vérification (test ou build) et te renvoie le résultat exact : ne relance pas toi-même le test ou le build, lis simplement ce résultat. La vérification comprend aussi le démarrage de l'application (npm start, page ouverte dans un navigateur) : si elle plante au démarrage, tu reçois l'erreur de démarrage. La page de l'application est aussi ouverte dans un navigateur : une erreur JavaScript ou un code HTTP 500 te sera signalé. Pour un nouveau projet ou une tâche de plusieurs fichiers : commence par l'outil plan (3 à 6 étapes courtes), réalise-les dans l'ordre, et quand les fichiers sont écrits appelle verify puis corrige ce qu'il signale. Quand la vérification passe, la tâche se termine toute seule. Note chaque erreur réglée avec l'outil note. Si une correction ne règle pas l'erreur, ne renonce pas : relis la sortie d'erreur et essaie une autre approche. N'appelle finish que si aucune vérification n'existe ou si plusieurs approches différentes ont échoué (explique alors précisément ce qui bloque). Le résumé de finish a deux parties : « Corrigé : ... » (les erreurs réglées) et « Reste à faire : ... » (ce qui bloque, ou « rien »). Pour un déploiement, utilise les outils en ligne de commande (vercel, wrangler, fly) ou curl vers l'API de l'hébergeur ; les clés nécessaires sont déjà dans l'environnement de run. Ne touche pas aux fichiers de CI. N'affiche jamais de variables d'environnement. Réponds uniquement par des appels d'outils.`;

// Historique allégé : tout ce qui est plus ancien que les 6 derniers messages est réduit à quelques mots
// (sorties d'outils, contenus des fichiers écrits, rapports de vérification). Les 2 premiers messages
// (consigne et tâche) et les 6 derniers restent complets. Aucun message n'est supprimé : les appels
// d'outils et leurs résultats restent appariés.
const KEEP_FULL = 6;
const shrinkArgs = (c) => {
  const a = (c.function && c.function.arguments) || "";
  if (a.length <= 300) return c;
  let stub = "{}";
  try {
    const o = JSON.parse(a);
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "string" && o[k].length > 200) o[k] = "[" + o[k].length + " caractères]";
    }
    stub = JSON.stringify(o);
  } catch {}
  return { ...c, function: { ...c.function, arguments: stub } };
};
// La limite avance par paquets de 4 messages (pas d'un message à la fois) : entre deux paliers, le début de
// l'historique reste identique d'une étape à l'autre, donc le cache du fournisseur (moins cher) peut servir.
const compact = (m) => {
  const keepFrom = Math.max(2, m.length - KEEP_FULL - ((m.length - KEEP_FULL) % 4));
  return m.map((x, i) => {
    if (i < 2 || i >= keepFrom) return x;
    const text = typeof x.content === "string" ? x.content : "";
    if (x.role === "tool" && text.length > 200) return { ...x, content: text.slice(0, 200) + " [...]" };
    if (x.role === "user" && text.length > 400) return { ...x, content: text.slice(0, 400) + " [...]" };
    if (x.role === "assistant") {
      const compactContent = text.length > 300 ? text.slice(0, 300) + " [...]" : text;
      return {
        ...x,
        ...(typeof x.content === "string" ? { content: compactContent } : {}),
        ...(Array.isArray(x.tool_calls) ? { tool_calls: x.tool_calls.map(shrinkArgs) } : {}),
      };
    }
    return x;
  });
};

// Appel de l'IA. Limite temporaire du fournisseur (429, 503) : nouvelles tentatives après une courte attente.
// Le budget de tokens de la tâche ou du jour (message « budget ») n'est pas réessayé.
async function llm(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api("/internal/llm/chat/completions", { method: "POST", body: JSON.stringify(body) });
    } catch (err) {
      const m = / (429|503) /.exec(err.message);
      if (!m || /budget/.test(err.message) || attempt >= 4) throw err;
      // Limite journalière du fournisseur (plan gratuit) : attendre ne sert à rien.
      if (/free_tier|PerDay|per day|exceeded your current quota/i.test(err.message)) throw new Error("Limite journalière du fournisseur de l'IA atteinte : change de clé ou de modèle. " + err.message.slice(0, 200));
      const wait = 15 * (attempt + 1);
      progress(`Limite de l'IA atteinte (${m[1]}), nouvelle tentative dans ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function agent(first) {
  const messages = [{ role: "system", content: SYSTEM + (TIER === "soleil" ? SOLEIL_NOTE : "") }, { role: "user", content: first }];
  const toolList = toolDefs.filter((d) => d.function.name !== "ask_expert" || TIER === "soleil");
  let autoAsked = 0;
  const notes = [];
  let reruns = 0;
  // Garde-fou : même erreur après plusieurs corrections = l'IA tourne en rond (et brûle des tokens).
  let lastSig = "";
  let same = 0;
  for (let step = 0; step < 40; step++) {
    const data = await llm({ messages: compact(messages), tools: toolList, tool_choice: "auto" });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("réponse LLM vide");
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) return msg.content || "Terminé.";
    let summary = null;
    let dirty = false;
    for (const c of calls) {
      let out;
      try {
        const args = JSON.parse(c.function.arguments || "{}");
        if (c.function.name === "note") {
          const text = String(args.text || "");
          notes.push(text.slice(0, 120));
          progress(text);
          out = "ok";
        } else {
          const label = `${c.function.name} ${args.path || args.command || args.pattern || args.dir || ""}`.trim();
          progress(label);
          TRIED.push(label.slice(0, 160));
          if (c.function.name === "finish") {
            summary = args.summary || "Terminé.";
            out = "ok";
          } else if (tools[c.function.name]) {
            out = await tools[c.function.name](args);
            if (c.function.name === "write_file" || c.function.name === "edit_file") dirty = true;
          } else {
            out = "outil inconnu";
          }
        }
      } catch (err) {
        out = "Erreur : " + err.message;
      }
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: trunc(scrub(out)) });
    }
    if (summary !== null) return summary;

    // Le terminal relance lui-même la vérification après chaque fichier écrit (8 fois au plus).
    if (dirty && CHECK && reruns < 8) {
      reruns++;
      progress(`Vérification relancée (${CHECK.label})`);
      const r = sh(CHECK.command, 280000);
      progress(r.code === 0 ? "Vérification réussie" : `Vérification en erreur (code ${r.code})`);
      if (r.code !== 0) LAST_OUT = r.out;
      if (r.code === 0 && CHECK.failedAtStart) {
        const done = notes.length ? notes.join(" ; ") : "les erreurs de départ";
        return `Corrigé : ${done}. Reste à faire : rien (${CHECK.label} passe maintenant).`;
      }
      const sig = r.code === 0 ? "" : tail(scrub(r.out), 600);
      same = sig && sig === lastSig ? same + 1 : 0;
      lastSig = sig;
      if (same >= 4) {
        const done = notes.length ? notes.join(" ; ") : "rien";
        return `Corrigé : ${done}. Reste à faire : ${CHECK.label} échoue toujours avec la même erreur après ${same + 1} essais : ${sig.slice(-300)}`;
      }
      const hint = same >= 2 ? "\nATTENTION : l'erreur est identique après plusieurs corrections, tes modifications ne la changent pas. Relis le fichier autour de la ligne en erreur avec read_file, cherche la vraie cause avec search_code, et change d'approche." : "";
      // Soleil : même erreur après plusieurs corrections -> l'expert donne les instructions, l'agent les applique.
      let advice = "";
      if (TIER === "soleil" && same >= 2 && autoAsked < 2) {
        autoAsked++;
        try {
          advice = await askExpert("L'agent est bloqué : la même erreur revient après plusieurs corrections. Donne les instructions exactes pour la régler.");
        } catch (err) {
          progress(`Expert indisponible : ${scrub(err.message).slice(0, 100)}`);
        }
      }
      const adviceText = advice ? `\nCONSEIL DE L'EXPERT (applique-le à la lettre avec edit_file) :\n${scrub(advice)}` : "";
      messages.push({
        role: "user",
        content: `Vérification automatique relancée par le terminal : ${CHECK.label} -> code ${r.code}\n${tail(scrub(r.out))}\n${r.code === 0 ? "La vérification passe. Termine la tâche demandée puis appelle finish." : "Corrige l'erreur suivante, une seule à la fois."}${hint}${adviceText}${PLAN.length ? "\nRappel du plan : " + PLAN.map((x, i) => `${i + 1}. ${x}`).join(" | ") : ""}`,
      });
    }
  }
  throw new Error("nombre maximum d'étapes atteint");
}

// ------------------------------------------------------------------ déroulé
try {
  const job = await api("/internal/job");
  ghToken = job.ghToken;
  svcEnv = job.svc || {};
  TIER = job.tier === "soleil" ? "soleil" : "aube";

  let repo = job.repo;
  let base = job.base;
  if (job.newRepo) {
    const cr = await gh("/user/repos", { method: "POST", body: JSON.stringify({ name: job.newRepo, private: true, auto_init: true }) });
    if (!cr.ok) throw new Error(`création du dépôt impossible (${cr.status}) : le nom existe peut-être déjà`);
    const c = await cr.json();
    repo = c.full_name;
    base = c.default_branch;
  } else {
    const metaRes = await gh(`/repos/${repo}`);
    if (!metaRes.ok) throw new Error(`dépôt inaccessible (${metaRes.status}) : vérifie le token GitHub`);
    base = base || (await metaRes.json()).default_branch;
  }

  progress(`Clonage de ${repo}`);
  fs.mkdirSync("/work", { recursive: true });
  git(["clone", "--depth", "50", "--branch", base, `https://github.com/${repo}.git`, ROOT], "/work");
  const branch = job.newRepo ? null : `ai-fix/${job.id}`;
  if (branch) git(["checkout", "-b", branch]);

  if (!job.newRepo) progress("Vérifications automatiques en cours (installation, test ou build, démarrage)");
  const checks = job.newRepo ? "Projet vide, rien à vérifier." : autoChecks();
  progress("Vérifications terminées, l'IA analyse les erreurs");
  const files = git(["ls-files"]).split("\n").filter(Boolean);
  let excerpts = "";
  if (CHECK && CHECK.failedAtStart) {
    try {
      excerpts = errorContext(checks);
    } catch {}
  }
  const first = `Dépôt : ${repo}\nTâche : ${job.instructions}\n\nFichiers (${files.length}) :\n${files.slice(0, 60).join("\n")}\n\nVérifications automatiques :\n${checks}${excerpts ? `\n\nExtraits des fichiers cités par l'erreur (déjà lus pour toi) :${excerpts}` : ""}\n\nRappel : corrige les erreurs une à la fois ; le terminal relance seul la vérification après chaque fichier écrit ; continue jusqu'à ce que tout passe.`;

  const summary = await agent(first);

  if (!git(["status", "--porcelain"]).trim()) {
    await report({ status: "success", summary: `Aucun changement de code. ${summary}` });
  } else {
    progress("Envoi des corrections sur GitHub");
    git(["add", "-A"]);
    git(["commit", "-m", `${job.newRepo ? "feat" : "fix"}: ${job.instructions.split("\n")[0].slice(0, 60)} (automatique)`]);
    if (job.newRepo) {
      git(["push", "origin", `HEAD:refs/heads/${base}`]);
      await report({ status: "success", summary, branch: base, pr_url: `https://github.com/${repo}` });
    } else {
      git(["push", "origin", `HEAD:refs/heads/${branch}`]);
      const prRes = await gh(`/repos/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({ title: `Correction automatique : ${job.instructions.split("\n")[0].slice(0, 60)}`, head: branch, base, body: `${summary}\n\n_Généré par un agent IA dans un conteneur éphémère. À relire avant de fusionner._` }),
      });
      const pr = prRes.ok ? await prRes.json() : null;
      await report({ status: "success", summary, branch, pr_url: pr?.html_url });
    }
  }
} catch (err) {
  await report({ status: "failed", summary: `Échec : ${err.message}` });
}
process.exit(0);
