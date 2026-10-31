import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------- configuration
const e = process.env;
const need = (k) => {
  if (!e[k]) {
    console.error(`Variable manquante : ${k}`);
    process.exit(1);
  }
  return e[k];
};
const C = {
  port: Number(e.PORT || 8080),
  flyToken: need("FLY_API_TOKEN"),
  app: need("SANDBOX_APP"),
  image: need("SANDBOX_IMAGE"),
  secret: need("ORCHESTRATOR_SECRET"),
  publicUrl: need("ORCHESTRATOR_PUBLIC_URL").replace(/\/$/, ""),
  libreUrl: (e.LIBRECHAT_URL || "https://librechat-a7cwuq.fly.dev").replace(/\/$/, ""),
  llmKey: need("LLM_API_KEY"),
  llmBase: (e.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, ""),
  llmModel: e.LLM_MODEL || "gemini-2.5-flash",
  region: e.SANDBOX_REGION || "ams",
  memoryMb: Number(e.SANDBOX_MEMORY_MB || 1024),
  maxRuntimeSec: Number(e.MAX_RUNTIME_SEC || 900),
  perUserConcurrent: Number(e.MAX_CONCURRENT_PER_USER || 1),
  globalConcurrent: Number(e.MAX_CONCURRENT_GLOBAL || 4),
  jobsPerDay: Number(e.DAILY_JOBS_PER_USER || 5),
  tokensPerJob: Number(e.TOKENS_PER_JOB || 150000),
  tokensPerDay: Number(e.TOKENS_PER_USER_DAY || 400000),
};

// Clés de services (en-tête -> variable d'environnement du conteneur).
// Les en-têtes restent acceptés mais ne sont plus obligatoires : l'utilisateur peut aussi envoyer
// ses clés dans le chat, l'IA les passe alors en paramètres de run_task (voir svcFromParams).
const SVC = {
  "x-svc-vercel": "VERCEL_TOKEN",
  "x-svc-cloudflare": "CLOUDFLARE_API_TOKEN",
  "x-svc-render": "RENDER_API_KEY",
  "x-svc-fly": "FLY_API_TOKEN",
};
const svcFrom = (h) => {
  const o = {};
  for (const [k, v] of Object.entries(SVC)) {
    const x = String(h[k] || "");
    if (x.length >= 8 && !x.includes("{{")) o[v] = x;
  }
  return o;
};

// Clés envoyées dans le chat : paramètres facultatifs de run_task -> variables du conteneur.
const svcFromParams = (p) => {
  const o = {};
  if (p.vercel_token) o.VERCEL_TOKEN = p.vercel_token;
  if (p.cloudflare_token) o.CLOUDFLARE_API_TOKEN = p.cloudflare_token;
  if (p.render_key) o.RENDER_API_KEY = p.render_key;
  if (p.fly_token) o.FLY_API_TOKEN = p.fly_token;
  return o;
};

const tokenParam = (label) => z.string().min(8).max(500).regex(/^\S+$/).optional().describe(label);

// ---------------------------------------------------------------- base de données
const dbPath = e.DB_PATH || "/data/orch.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, repo TEXT NOT NULL, base TEXT, instructions TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, machine_id TEXT, tokens_used INTEGER NOT NULL DEFAULT 0,
  summary TEXT, branch TEXT, pr_url TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id, status);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, jobs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`);
// Journal d'activité de la tâche (ajouté après coup : ignoré si la colonne existe déjà).
try {
  db.exec("ALTER TABLE jobs ADD COLUMN activity TEXT");
} catch {}

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ACTIVE = "('queued','running')";

// Jetons et clés : gardés en mémoire seulement, remis une seule fois au worker.
const creds = new Map();

// ---------------------------------------------------------------- connexion GitHub (via LibreChat)
// Lien signé : prouve à LibreChat que la demande vient de cet orchestrateur pour cet utilisateur.
const hmac = (s) => crypto.createHmac("sha256", C.secret).update(s).digest("hex");
function connectLink(userId) {
  const exp = Date.now() + 30 * 60000;
  return `${C.libreUrl}/api/github-link/start?u=${encodeURIComponent(userId)}&e=${exp}&s=${hmac(`${userId}.${exp}`)}`;
}

// Token GitHub de l'utilisateur, rangé chiffré côté LibreChat quand il a connecté son compte.
async function linkedToken(userId) {
  try {
    const r = await fetch(`${C.libreUrl}/api/github-link/token?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${C.secret}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.token === "string" && d.token.length >= 20 ? d.token : null;
  } catch {
    return null;
  }
}

// GitHub : les deux voies marchent. 1) compte connecté via LibreChat (prioritaire),
// 2) token envoyé dans le chat (paramètre github_token), 3) ancien en-tête X-GitHub-Token (secours).
async function pickGithub(userId, chatToken, headerToken) {
  const linked = await linkedToken(userId);
  if (linked) return linked;
  for (const t of [chatToken, headerToken]) {
    if (t && !t.includes("{{") && t.length >= 20) return t;
  }
  return "";
}

const githubMissing = (userId, then) =>
  `GitHub n'est pas encore connecté pour cet utilisateur. Propose-lui deux choix : (1) connecter son compte GitHub avec ce lien, à lui donner tel quel (une seule fois, valable 30 minutes) : ${connectLink(userId)} ; ou (2) générer un token GitHub avec accès à son dépôt (droits Contents et Pull requests en lecture/écriture) et te l'envoyer dans le chat. Si c'est un token, rappelle ${then} en le passant dans github_token.`;

// ---------------------------------------------------------------- recherche de dépôts (noms approximatifs)
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Ressemblance entre deux mots : 1 = identique, 0 = rien en commun (tolère les fautes de frappe).
const sim = (a, b) => {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.85;
  return Math.max(0, 1 - lev(a, b) / Math.max(a.length, b.length));
};

// Tous les dépôts auxquels le token donne accès (300 au plus), les plus récents d'abord.
async function userRepos(token) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(
      `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "jeremy-orchestrateur" },
        signal: AbortSignal.timeout(15000),
      }
    );
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const list = await r.json();
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

async function searchRepos(token, query) {
  const q = words(query);
  if (!q.length) return [];
  const scored = [];
  for (const repo of await userRepos(token)) {
    const nameWords = words(repo.name);
    const descWords = words(repo.description);
    let total = 0;
    for (const w of q) {
      const inName = Math.max(0, ...nameWords.map((n) => sim(w, n)));
      const inDesc = Math.max(0, ...descWords.map((d) => sim(w, d)));
      total += Math.max(inName >= 0.6 ? inName : 0, inDesc >= 0.8 ? inDesc * 0.5 : 0);
    }
    const score = total / q.length;
    if (score >= 0.45) scored.push({ score, repo });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map(({ repo }) => ({
    repo: repo.full_name,
    private: Boolean(repo.private),
    description: String(repo.description || "").slice(0, 100),
    updated: String(repo.pushed_at || repo.updated_at || "").slice(0, 10),
  }));
}

// ---------------------------------------------------------------- API Fly Machines
async function fly(method, p, body) {
  const r = await fetch(`https://api.machines.dev/v1/apps/${C.app}${p}`, {
    method,
    headers: { Authorization: `Bearer ${C.flyToken}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Fly ${r.status} : ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function launch(jobId, userId, token) {
  const m = await fly("POST", "/machines", {
    name: `job-${jobId}`,
    region: C.region,
    config: {
      image: C.image,
      auto_destroy: true,
      restart: { policy: "no" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: C.memoryMb },
      env: { JOB_TOKEN: token, ORCHESTRATOR_URL: C.publicUrl, MAX_RUNTIME_SEC: String(C.maxRuntimeSec) },
      metadata: { job_id: jobId, user_id: userId },
    },
  });
  db.prepare("UPDATE jobs SET machine_id=?, status='running' WHERE id=?").run(m.id, jobId);
}

async function killMachine(id) {
  try {
    await fly("DELETE", `/machines/${id}?force=true`);
  } catch (err) {
    if (!/404/.test(err.message)) console.error("kill:", err.message);
  }
}

// ---------------------------------------------------------------- tâches
function finish(id, status, summary, extra = {}) {
  creds.delete(id);
  db.prepare(
    `UPDATE jobs SET status=?, summary=?, branch=COALESCE(?,branch), pr_url=COALESCE(?,pr_url), finished_at=?
     WHERE id=? AND status IN ${ACTIVE}`
  ).run(status, String(summary || "").slice(0, 2000), extra.branch || null, extra.pr_url || null, Date.now(), id);
}

function reserveJob(userId, repo, base, instructions) {
  const day = today();
  return db.transaction(() => {
    const u = db.prepare("SELECT tokens, jobs FROM usage WHERE user_id=? AND day=?").get(userId, day) || { tokens: 0, jobs: 0 };
    if (u.jobs >= C.jobsPerDay) return { error: `Quota atteint : ${C.jobsPerDay} tâches par jour.` };
    if (u.tokens >= C.tokensPerDay) return { error: "Quota de tokens du jour atteint." };
    const mine = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE user_id=? AND status IN ${ACTIVE}`).get(userId).n;
    if (mine >= C.perUserConcurrent) return { error: "Une tâche est déjà en cours pour toi. Attends qu'elle se termine." };
    const all = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status IN ${ACTIVE}`).get().n;
    if (all >= C.globalConcurrent) return { error: "Serveur occupé, réessaie dans quelques minutes." };
    const id = crypto.randomBytes(6).toString("hex");
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare(
      "INSERT INTO jobs (id,user_id,repo,base,instructions,token_hash,status,created_at) VALUES (?,?,?,?,?,?,'queued',?)"
    ).run(id, userId, repo, base || null, instructions, sha(token), Date.now());
    db.prepare("INSERT INTO usage (user_id,day,jobs) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET jobs=jobs+1").run(userId, day);
    return { id, token };
  })();
}

const jobFromReq = (req) => {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  return m ? db.prepare("SELECT * FROM jobs WHERE token_hash=?").get(sha(m[1])) || null : null;
};

// Filet de sécurité : tue les machines expirées ou orphelines.
async function sweep() {
  try {
    const limitMs = (C.maxRuntimeSec + 60) * 1000;
    for (const j of db.prepare(`SELECT id, machine_id, created_at FROM jobs WHERE status IN ${ACTIVE}`).all()) {
      if (Date.now() - j.created_at > limitMs) {
        if (j.machine_id) await killMachine(j.machine_id);
        finish(j.id, "failed", "Délai maximum dépassé.");
      }
    }
    const machines = await fly("GET", "/machines");
    for (const m of machines) {
      const id = m.config?.metadata?.job_id;
      if (!id) continue;
      const j = db.prepare("SELECT status FROM jobs WHERE id=?").get(id);
      if (!j || !(j.status === "queued" || j.status === "running")) await killMachine(m.id);
    }
  } catch (err) {
    console.error("sweep:", err.message);
  }
}
setInterval(sweep, 30000);
sweep();

// ---------------------------------------------------------------- serveur MCP (LibreChat)
const ok = (t) => ({ content: [{ type: "text", text: t }] });
const ko = (t) => ({ content: [{ type: "text", text: t }], isError: true });

function buildServer(userId, ghHeader, svcHeaders) {
  const s = new McpServer({ name: "fly-sandboxes", version: "2.3.0" });

  s.tool(
    "find_repos",
    "Cherche parmi les dépôts GitHub de l'utilisateur (publics et privés) ceux qui ressemblent à un nom ou à des mots-clés, même approximatifs ou mal orthographiés. À appeler AVANT run_task dès que l'utilisateur ne donne pas le nom exact proprietaire/nom. Retourne une courte liste à proposer à l'utilisateur pour confirmation. Si l'utilisateur t'a envoyé un token GitHub dans le chat, passe-le dans github_token.",
    {
      query: z.string().min(2).max(100).describe("Nom approximatif ou mots-clés du projet, tels que l'utilisateur les a écrits"),
      github_token: tokenParam("Token GitHub envoyé par l'utilisateur dans le chat (seulement s'il n'a pas connecté son compte)"),
    },
    async ({ query, github_token }) => {
      const gh = await pickGithub(userId, github_token, ghHeader);
      if (!gh) return ko(githubMissing(userId, "find_repos"));
      try {
        const repos = await searchRepos(gh, query);
        if (!repos.length) {
          return ok(`Aucun dépôt ne ressemble à « ${query.slice(0, 100)} ». Demande à l'utilisateur de préciser le nom du projet.`);
        }
        return ok(JSON.stringify(repos));
      } catch (err) {
        console.error("find_repos:", err.message);
        return ko("Impossible de lire les dépôts GitHub pour le moment. Si l'utilisateur a envoyé un token, il est peut-être invalide ou sans accès à ses dépôts.");
      }
    }
  );

  s.tool(
    "run_task",
    "Exécute une tâche de développement ou de déploiement dans un conteneur Linux isolé et jetable : clone d'un dépôt GitHub (ou création d'un nouveau projet), vérifications automatiques, correction de la première erreur par l'IA, commandes (Vercel, Cloudflare, Render, Fly...), push et pull request. Appeler UNE seule fois ; retourne un job_id tout de suite, puis suivre avec get_job. Ne pas lire les fichiers soi-même. Le nom du dépôt doit être exact : s'il ne l'est pas, appeler find_repos d'abord. Clés de services : si la tâche demande Vercel, Cloudflare, Render ou Fly.io, demande à l'utilisateur de générer sa clé (token) sur le site du service et de te l'envoyer dans le chat, puis passe-la dans le paramètre correspondant. Ne demande que les clés dont la tâche a besoin.",
    {
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe("Dépôt existant : proprietaire/nom"),
      new_repo_name: z.string().regex(/^[\w.-]{1,100}$/).optional().describe("Nom d'un NOUVEAU dépôt privé à créer (au lieu de repo)"),
      instructions: z.string().min(10).max(4000).describe("Ce qu'il faut faire : bug à corriger, projet à créer, déploiement à lancer"),
      base_branch: z.string().max(100).regex(/^[\w./-]+$/).optional(),
      github_token: tokenParam("Token GitHub envoyé dans le chat (seulement si l'utilisateur n'a pas connecté son compte GitHub)"),
      vercel_token: tokenParam("Clé Vercel envoyée par l'utilisateur dans le chat, si la tâche déploie sur Vercel"),
      cloudflare_token: tokenParam("Clé Cloudflare envoyée par l'utilisateur dans le chat, si la tâche utilise Cloudflare"),
      render_key: tokenParam("Clé Render envoyée par l'utilisateur dans le chat, si la tâche utilise Render"),
      fly_token: tokenParam("Clé Fly.io envoyée par l'utilisateur dans le chat, si la tâche utilise Fly.io"),
    },
    async (args) => {
      const { repo, new_repo_name, instructions, base_branch } = args;
      if (!repo && !new_repo_name) return ko("Indique repo (dépôt existant) ou new_repo_name (nouveau projet).");
      // Le compte GitHub connecté via LibreChat passe en premier ; sinon le token envoyé dans le chat.
      const gh = await pickGithub(userId, args.github_token, ghHeader);
      if (!gh) return ko(githubMissing(userId, "run_task"));
      // Les clés envoyées dans le chat priment sur d'éventuels en-têtes.
      const svc = { ...svcHeaders, ...svcFromParams(args) };
      const r = reserveJob(userId, repo || `(nouveau)/${new_repo_name}`, base_branch, instructions);
      if (r.error) return ko(r.error);
      creds.set(r.id, { ghToken: gh, repo: repo || null, newRepo: new_repo_name || null, base: base_branch || null, instructions, svc, exp: Date.now() + 5 * 60000 });
      try {
        await launch(r.id, userId, r.token);
      } catch (err) {
        console.error("launch:", err.message);
        finish(r.id, "failed", "Échec du démarrage du conteneur.");
        db.prepare("UPDATE usage SET jobs=MAX(jobs-1,0) WHERE user_id=? AND day=?").run(userId, today());
        return ko("Impossible de démarrer le conteneur pour le moment.");
      }
      return ok(`Tâche ${r.id} lancée. Le conteneur se détruit seul à la fin. Ensuite : écris à l'utilisateur une phrase courte du genre « Travail en cours, patiente un peu, je te fais le retour dès que c'est fini. », puis appelle get_job (job_id=${r.id}, wait_seconds=45) et recommence tant que le statut est running. Quand il est success ou failed, donne le résultat.`);
    }
  );

  s.tool(
    "get_job",
    "Statut d'une tâche (running, success, failed), résumé (Corrigé / Reste à faire), branche, lien de la pull request, tokens consommés et activité récente (activite : les dernières actions du conteneur). Avec wait_seconds (45 au plus), attend la fin de la tâche avant de répondre.",
    {
      job_id: z.string().regex(/^[a-f0-9]{12}$/),
      wait_seconds: z.number().int().min(0).max(45).optional(),
    },
    async ({ job_id, wait_seconds }) => {
      const deadline = Date.now() + (wait_seconds || 0) * 1000;
      let j;
      for (;;) {
        j = db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(job_id, userId);
        if (!j) return ko("Tâche introuvable.");
        if (!(j.status === "queued" || j.status === "running") || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const running = j.status === "queued" || j.status === "running";
      const activite = String(j.activity || "").split("\n").filter(Boolean).slice(-8);
      const out = { job_id: j.id, repo: j.repo, status: j.status, summary: j.summary, branch: j.branch, pull_request: j.pr_url, tokens_used: j.tokens_used, activite };
      if (running) out.consigne = "Toujours en cours : dis en une phrase où ça en est d'après activite, puis rappelle get_job avec wait_seconds=45.";
      return ok(JSON.stringify(out));
    }
  );

  s.tool("my_quota", "Quotas restants de l'utilisateur pour aujourd'hui.", {}, async () => {
    const u = db.prepare("SELECT tokens, jobs FROM usage WHERE user_id=? AND day=?").get(userId, today()) || { tokens: 0, jobs: 0 };
    return ok(JSON.stringify({
      jobs_restants: Math.max(C.jobsPerDay - u.jobs, 0),
      tokens_restants: Math.max(C.tokensPerDay - u.tokens, 0),
      tokens_max_par_tache: C.tokensPerJob,
    }));
  });

  return s;
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));

function mcpAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m || !safeEq(m[1], C.secret)) return res.status(401).json({ error: "non autorisé" });
  const user = String(req.headers["x-user-id"] || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(user)) return res.status(400).json({ error: "X-User-Id invalide" });
  req.userId = user;
  next();
}

app.post("/mcp", mcpAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const server = buildServer(req.userId, String(req.headers["x-github-token"] || ""), svcFrom(req.headers));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp:", err.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erreur interne" }, id: null });
  }
});
app.all("/mcp", (_req, res) => res.status(405).json({ error: "méthode non autorisée" }));

// --- routes internes (worker)
app.get("/internal/job", (req, res) => {
  const job = jobFromReq(req);
  if (!job) return res.status(401).json({ error: "jeton invalide" });
  const c = creds.get(job.id);
  if (!c || c.exp < Date.now()) return res.status(410).json({ error: "identifiants expirés" });
  creds.delete(job.id);
  res.json({ id: job.id, repo: c.repo, newRepo: c.newRepo, base: c.base, instructions: c.instructions, ghToken: c.ghToken, svc: c.svc });
});

// Journal d'activité : une ligne courte par action du conteneur, lue ensuite par get_job.
app.post("/internal/progress", express.json({ limit: "16kb" }), (req, res) => {
  const job = jobFromReq(req);
  if (!job) return res.status(401).json({ error: "jeton invalide" });
  const line = String(req.body?.line || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (line && (job.status === "queued" || job.status === "running")) {
    const next = (job.activity ? `${job.activity}\n` : "") + line;
    db.prepare("UPDATE jobs SET activity=? WHERE id=?").run(next.slice(-3000), job.id);
  }
  res.json({ ok: true });
});

app.post("/internal/llm/chat/completions", express.json({ limit: "4mb" }), async (req, res) => {
  const job = jobFromReq(req);
  if (!job) return res.status(401).json({ error: "jeton invalide" });
  if (!(job.status === "queued" || job.status === "running")) return res.status(409).json({ error: "tâche terminée" });
  const maxOut = Math.min(Number(req.body.max_tokens) || 4096, 4096);
  const day = db.prepare("SELECT tokens FROM usage WHERE user_id=? AND day=?").get(job.user_id, today())?.tokens || 0;
  if (job.tokens_used + maxOut > C.tokensPerJob) return res.status(429).json({ error: "budget de tokens de la tâche épuisé" });
  if (day + maxOut > C.tokensPerDay) return res.status(429).json({ error: "budget de tokens du jour épuisé" });
  try {
    const r = await fetch(`${C.llmBase}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${C.llmKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: C.llmModel,
        messages: req.body.messages,
        tools: req.body.tools,
        tool_choice: req.body.tool_choice,
        temperature: 0.2,
        max_tokens: maxOut,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const data = await r.json().catch(() => ({}));
    const used = Number(data.usage?.total_tokens) || Math.ceil(JSON.stringify(req.body.messages || []).length / 3) + maxOut;
    db.transaction(() => {
      db.prepare("UPDATE jobs SET tokens_used=tokens_used+? WHERE id=?").run(used, job.id);
      db.prepare("INSERT INTO usage (user_id,day,tokens) VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET tokens=tokens+?").run(job.user_id, today(), used, used);
    })();
    res.status(r.status).json(data);
  } catch (err) {
    console.error("llm:", err.message);
    res.status(502).json({ error: "erreur du fournisseur LLM" });
  }
});

app.post("/internal/result", express.json({ limit: "256kb" }), (req, res) => {
  const job = jobFromReq(req);
  if (!job) return res.status(401).json({ error: "jeton invalide" });
  const { status, summary, branch, pr_url } = req.body || {};
  finish(job.id, status === "success" ? "success" : "failed", summary, { branch, pr_url });
  res.json({ ok: true });
  if (job.machine_id) setTimeout(() => killMachine(job.machine_id), 20000);
});

app.listen(C.port, "0.0.0.0", () => console.log(`Orchestrateur prêt sur :${C.port}`));
