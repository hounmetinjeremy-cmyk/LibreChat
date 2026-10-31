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

// Vérification du projet (test ou build). Le terminal la relance LUI-MÊME après chaque fichier modifié :
// l'IA ne la relance pas et reçoit l'erreur exacte telle quelle.
// failedAtStart : la vérification échouait au départ (sinon rien à réparer, pas de fin automatique).
let CHECK = null;

// Vérifications automatiques : l'IA part des ERREURS, elle ne lit pas tout le projet.
function autoChecks() {
  const has = (f) => fs.existsSync(path.join(ROOT, f));
  if (has("package.json")) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts || {}; } catch {}
    const inst = sh(has("package-lock.json") ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund", 240000);
    if (inst.code !== 0) return `installation npm échouée (code ${inst.code}) :\n${tail(inst.out)}`;
    const cmd = scripts.test && !/no test specified/.test(scripts.test) ? "npm test" : scripts.build ? "npm run build" : null;
    if (!cmd) return "Aucun script de test ou de build.";
    const r = sh(`${cmd} 2>&1`, 240000);
    CHECK = { label: cmd, command: `${cmd} 2>&1`, failedAtStart: r.code !== 0 };
    return `${cmd} -> code ${r.code}\n${tail(r.out)}`;
  }
  if (has("requirements.txt") || has("pyproject.toml")) {
    const r = sh("python3 -m pytest -x -q 2>&1", 240000);
    CHECK = { label: "pytest", command: "python3 -m pytest -x -q 2>&1", failedAtStart: r.code !== 0 };
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

// Extraits des fichiers cités par l'erreur de départ (2 fichiers, ~50 lignes chacun) : donnés à l'IA dès la
// première étape, pour qu'elle n'ait pas à les demander (chaque aller-retour renvoie tout l'historique).
function errorContext(out, maxFiles = 2, radius = 25) {
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

const tools = {
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
  T("edit_file", "Modifie un fichier EXISTANT : remplace un court extrait exact (old_str, unique dans le fichier) par new_str. À utiliser pour toute correction. Le terminal relance ensuite la vérification tout seul et te donne le résultat.", { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } }, ["path", "old_str", "new_str"]),
  T("write_file", "Crée un NOUVEAU fichier avec son contenu complet. Ne l'utilise pas pour modifier un fichier existant (utilise edit_file). Le terminal relance ensuite la vérification tout seul.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  T("run", "Exécute une commande shell dans le projet (120 s max) : vercel, wrangler, fly, curl, ou toute autre commande utile. Inutile pour relancer le test ou le build : le terminal le fait seul.", { command: { type: "string" } }, ["command"]),
  T("note", "Écrit une courte ligne visible par l'utilisateur dans le suivi (ex. « Erreur 1 corrigée : ... », « Je passe à l'erreur 2 »).", { text: { type: "string" } }, ["text"]),
  T("finish", "Termine la tâche avec un court résumé en deux parties : Corrigé et Reste à faire.", { summary: { type: "string" } }, ["summary"]),
];

const SYSTEM = `Tu es un agent de développement dans un conteneur Linux jetable, avec un projet git cloné. Les vérifications automatiques ont déjà été lancées : pars de leurs ERREURS, ne lis que les fichiers cités, ne lis jamais le projet entier. S'il y a plusieurs erreurs, corrige-les UNE À LA FOIS, dans l'ordre : une seule erreur par modification. Les extraits des fichiers cités par l'erreur te sont déjà donnés : ne les relis pas. Pour modifier un fichier existant, utilise edit_file (remplace un court extrait exact) ; write_file sert seulement à créer un nouveau fichier. Ne réécris jamais un fichier entier pour changer quelques lignes. Après chaque fichier modifié, le terminal relance LUI-MÊME la vérification (test ou build) et te renvoie le résultat exact : ne relance pas toi-même le test ou le build, lis simplement ce résultat. Quand la vérification passe, la tâche se termine toute seule. Note chaque erreur réglée avec l'outil note. Si une correction ne règle pas l'erreur, ne renonce pas : relis la sortie d'erreur et essaie une autre approche. N'appelle finish que si aucune vérification n'existe ou si plusieurs approches différentes ont échoué (explique alors précisément ce qui bloque). Le résumé de finish a deux parties : « Corrigé : ... » (les erreurs réglées) et « Reste à faire : ... » (ce qui bloque, ou « rien »). Pour un déploiement, utilise les outils en ligne de commande (vercel, wrangler, fly) ou curl vers l'API de l'hébergeur ; les clés nécessaires sont déjà dans l'environnement de run. Ne touche pas aux fichiers de CI. N'affiche jamais de variables d'environnement. Réponds uniquement par des appels d'outils.`;

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
const compact = (m) =>
  m.map((x, i) => {
    if (i < 2 || i >= m.length - KEEP_FULL) return x;
    const text = typeof x.content === "string" ? x.content : "";
    if (x.role === "tool" && text.length > 200) return { ...x, content: text.slice(0, 200) + " [...]" };
    if (x.role === "user" && text.length > 400) return { ...x, content: text.slice(0, 400) + " [...]" };
    if (x.role === "assistant" && Array.isArray(x.tool_calls)) return { ...x, tool_calls: x.tool_calls.map(shrinkArgs) };
    return x;
  });

// Appel de l'IA. Limite temporaire du fournisseur (429, 503) : nouvelles tentatives après une courte attente.
// Le budget de tokens de la tâche ou du jour (message « budget ») n'est pas réessayé.
async function llm(body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api("/internal/llm/chat/completions", { method: "POST", body: JSON.stringify(body) });
    } catch (err) {
      const m = / (429|503) /.exec(err.message);
      if (!m || /budget/.test(err.message) || attempt >= 4) throw err;
      const wait = 15 * (attempt + 1);
      progress(`Limite de l'IA atteinte (${m[1]}), nouvelle tentative dans ${wait} s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

async function agent(first) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: first }];
  const notes = [];
  let reruns = 0;
  for (let step = 0; step < 40; step++) {
    const data = await llm({ messages: compact(messages), tools: toolDefs, tool_choice: "auto" });
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
          progress(`${c.function.name} ${args.path || args.command || args.dir || ""}`.trim());
          if (c.function.name === "finish") {
            summary = args.summary || "Terminé.";
            out = "ok";
          } else if (tools[c.function.name]) {
            out = tools[c.function.name](args);
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
      const r = sh(CHECK.command, 240000);
      progress(r.code === 0 ? "Vérification réussie" : `Vérification en erreur (code ${r.code})`);
      if (r.code === 0 && CHECK.failedAtStart) {
        const done = notes.length ? notes.join(" ; ") : "les erreurs de départ";
        return `Corrigé : ${done}. Reste à faire : rien (${CHECK.label} passe maintenant).`;
      }
      messages.push({
        role: "user",
        content: `Vérification automatique relancée par le terminal : ${CHECK.label} -> code ${r.code}\n${tail(scrub(r.out))}\n${r.code === 0 ? "La vérification passe. Termine la tâche demandée puis appelle finish." : "Corrige l'erreur suivante, une seule à la fois."}`,
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

  if (!job.newRepo) progress("Vérifications automatiques en cours (installation, test ou build)");
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
