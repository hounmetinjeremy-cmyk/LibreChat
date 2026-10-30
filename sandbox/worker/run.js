import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const { JOB_TOKEN, ORCHESTRATOR_URL, MAX_RUNTIME_SEC = "900" } = process.env;
const ROOT = "/work/repo";
let ghToken = "";
let reported = false;

const basicAuth = () => Buffer.from(`x-access-token:${ghToken}`).toString("base64");
const scrub = (s) => (ghToken ? String(s).split(ghToken).join("***").split(basicAuth()).join("***") : String(s));
const trunc = (s, n = 4000) => (s.length > n ? s.slice(0, n / 2) + "\n...[tronqué]...\n" + s.slice(-n / 2) : s);

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

// Garde-fou : la machine ne dépasse jamais sa durée maximale.
setTimeout(async () => {
  await report({ status: "failed", summary: "Délai maximum dépassé." });
  process.exit(1);
}, Number(MAX_RUNTIME_SEC) * 1000);

// ------------------------------------------------------------------ git / GitHub
// L'en-tête d'authentification passe par l'environnement (et non par les arguments) :
// si git échoue, le message d'erreur de Node recopie la ligne de commande, jamais l'environnement.
const gitEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basicAuth()}`,
});
const git = (args, cwd = ROOT) =>
  execFileSync("git", ["-c", "user.name=AI Fix Bot", "-c", "user.email=ai-fix-bot@users.noreply.github.com", ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300000,
  });
const gh = (p, opts = {}) =>
  fetch(`https://api.github.com${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fly-sandbox-worker",
      "Content-Type": "application/json",
    },
  });

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
    return files.slice(0, 300).join("\n") + (files.length > 300 ? `\n... (${files.length} fichiers)` : "");
  },
  read_file({ path: p, start = 1, end = 200 }) {
    const lines = fs.readFileSync(safe(p), "utf8").split("\n");
    const a = Math.max(start, 1);
    const b = Math.min(end, a + 199, lines.length);
    return lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join("\n") + `\n[lignes ${a}-${b} sur ${lines.length}]`;
  },
  write_file({ path: p, content }) {
    const full = safe(p);
    if (path.relative(ROOT, full).startsWith(".github")) throw new Error("modification de .github interdite");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return `écrit : ${p} (${content.length} caractères)`;
  },
  run({ command }) {
    // Environnement vide : ni jeton GitHub, ni jeton de tâche.
    const r = spawnSync("bash", ["-lc", command], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 5e6,
      env: { PATH: process.env.PATH, HOME: "/home/worker", CI: "1" },
    });
    return trunc(`code ${r.status ?? "timeout"}\n${r.stdout || ""}${r.stderr || ""}`);
  },
};

const T = (name, description, properties, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const toolDefs = [
  T("list_files", "Liste les fichiers suivis par git (300 max).", { dir: { type: "string" } }, []),
  T("read_file", "Lit un fichier, 200 lignes max par appel.", { path: { type: "string" }, start: { type: "integer" }, end: { type: "integer" } }, ["path"]),
  T("write_file", "Écrase un fichier avec son contenu complet.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  T("run", "Exécute une commande shell dans le dépôt (120 s max), par exemple les tests.", { command: { type: "string" } }, ["command"]),
  T("finish", "Termine la tâche avec un court résumé des changements.", { summary: { type: "string" } }, ["summary"]),
];

const SYSTEM = `Tu es un agent de correction de bugs dans un dépôt git cloné. Méthode : comprendre le bug, lire les fichiers concernés, faire le plus petit changement correct, lancer les tests s'il y en a, puis appeler finish. Règles : ne touche pas aux fichiers de CI, de secrets ou de configuration de déploiement ; n'ajoute aucune dépendance sans nécessité ; ne cherche jamais à lire des variables d'environnement ni des jetons ; réponds toujours par des appels d'outils.`;

async function agent(repo, instructions) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Dépôt : ${repo}\nTâche : ${instructions}` },
  ];
  for (let step = 0; step < 30; step++) {
    const data = await api("/internal/llm/chat/completions", { method: "POST", body: JSON.stringify({ messages, tools: toolDefs, tool_choice: "auto" }) });
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
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: trunc(String(out)) });
    }
    if (summary !== null) return summary;
  }
  throw new Error("nombre maximum d'étapes atteint");
}

// ------------------------------------------------------------------ déroulé
try {
  const job = await api("/internal/job");
  ghToken = job.ghToken;

  const metaRes = await gh(`/repos/${job.repo}`);
  if (!metaRes.ok) throw new Error(`dépôt inaccessible (${metaRes.status}) : vérifie le token GitHub`);
  const meta = await metaRes.json();
  const base = job.base || meta.default_branch;

  fs.mkdirSync("/work", { recursive: true });
  git(["clone", "--depth", "50", "--branch", base, `https://github.com/${job.repo}.git`, ROOT], "/work");
  const branch = `ai-fix/${job.id}`;
  git(["checkout", "-b", branch]);

  const summary = await agent(job.repo, job.instructions);

  if (!git(["status", "--porcelain"]).trim()) {
    await report({ status: "failed", summary: `Aucune modification produite. ${summary}` });
  } else {
    git(["add", "-A"]);
    git(["commit", "-m", `fix: ${job.instructions.split("\n")[0].slice(0, 60)} (correction automatique)`]);
    git(["push", "origin", `HEAD:refs/heads/${branch}`]);
    const prRes = await gh(`/repos/${job.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: `Correction automatique : ${job.instructions.split("\n")[0].slice(0, 60)}`, head: branch, base, body: `${summary}\n\n_Généré par un agent IA dans un conteneur éphémère. À relire avant de fusionner._` }),
    });
    const pr = prRes.ok ? await prRes.json() : null;
    await report({ status: "success", summary, branch, pr_url: pr?.html_url });
  }
} catch (err) {
  await report({ status: "failed", summary: `Échec : ${err.message}` });
}
process.exit(0);
