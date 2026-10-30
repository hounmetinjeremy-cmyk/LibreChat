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
  if (!r.ok) throw new Error(`${p} ${r.status} ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

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
    return `${cmd} -> code ${r.code}\n${tail(r.out)}`;
  }
  if (has("requirements.txt") || has("pyproject.toml")) {
    const r = sh("python3 -m pytest -x -q 2>&1", 240000);
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
  run({ command }) {
    const r = sh(command);
    return trunc(`code ${r.code}\n${r.out}`);
  },
};

const T = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const toolDefs = [
  T("list_files", "Liste les fichiers suivis par git (200 max).", { dir: { type: "string" } }, []),
  T("read_file", "Lit un fichier, 120 lignes max par appel.", { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, ["path"]),
  T("write_file", "Écrase un fichier avec son contenu complet.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  T("run", "Exécute une commande shell dans le projet (120 s max) : tests, build, vercel, wrangler, fly, curl.", { command: { type: "string" } }, ["command"]),
  T("finish", "Termine la tâche avec un court résumé.", { summary: { type: "string" } }, ["summary"]),
];

const SYSTEM = `Tu es un agent de développement dans un conteneur Linux jetable, avec un projet git cloné. Les vérifications automatiques ont déjà été lancées : pars de leurs ERREURS, ne lis que les fichiers cités, ne lis jamais le projet entier. Fais le plus petit changement correct, revérifie avec run, puis appelle finish. Pour un déploiement, utilise les outils en ligne de commande (vercel, wrangler, fly) ou curl vers l'API de l'hébergeur ; les clés nécessaires sont déjà dans l'environnement de run. Ne touche pas aux fichiers de CI. N'affiche jamais de variables d'environnement. Réponds uniquement par des appels d'outils.`;

// Les anciennes sorties d'outils sont raccourcies pour économiser les tokens.
const compact = (m) => m.map((x, i) => (x.role === "tool" && i < m.length - 6 && x.content.length > 300 ? { ...x, content: x.content.slice(0, 300) + " [...]" } : x));

async function agent(first) {
  const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: first }];
  for (let step = 0; step < 25; step++) {
    const data = await api("/internal/llm/chat/completions", { method: "POST", body: JSON.stringify({ messages: compact(messages), tools: toolDefs, tool_choice: "auto" }) });
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("réponse LLM vide");
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) return msg.content || "Terminé.";
    let summary = null;
    for (const c of calls) {
      let out;
      try {
        const args = JSON.parse(c.function.arguments || "{}");
        if (c.function.name === "finish") {
          summary = args.summary || "Terminé.";
          out = "ok";
        } else if (tools[c.function.name]) {
          out = tools[c.function.name](args);
        } else {
          out = "outil inconnu";
        }
      } catch (err) {
        out = "Erreur : " + err.message;
      }
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: trunc(scrub(out)) });
    }
    if (summary !== null) return summary;
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

  fs.mkdirSync("/work", { recursive: true });
  git(["clone", "--depth", "50", "--branch", base, `https://github.com/${repo}.git`, ROOT], "/work");
  const branch = job.newRepo ? null : `ai-fix/${job.id}`;
  if (branch) git(["checkout", "-b", branch]);

  const checks = job.newRepo ? "Projet vide, rien à vérifier." : autoChecks();
  const files = git(["ls-files"]).split("\n").filter(Boolean);
  const first = `Dépôt : ${repo}\nTâche : ${job.instructions}\n\nFichiers (${files.length}) :\n${files.slice(0, 60).join("\n")}\n\nVérifications automatiques :\n${checks}`;

  const summary = await agent(first);

  if (!git(["status", "--porcelain"]).trim()) {
    await report({ status: "success", summary: `Aucun changement de code. ${summary}` });
  } else {
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
