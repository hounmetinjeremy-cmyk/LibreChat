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

// Clés de services que chaque utilisateur peut fournir (en-tête -> variable d'environnement du conteneur).
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

function buildServer(userId, ghToken, svc) {
  const s = new McpServer({ name: "fly-sandboxes", version: "2.0.0" });

  s.tool(
    "run_task",
    "Exécute une tâche de développement ou de déploiement dans un conteneur Linux isolé et jetable : clone d'un dépôt GitHub (ou création d'un nouveau projet), vérifications automatiques, correction par l'IA, commandes (Vercel, Cloudflare, Render, Fly...), push et pull request. Appeler UNE seule fois ; retourne un job_id tout de suite. Ne pas lire les fichiers soi-même.",
    {
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe("Dépôt existant : proprietaire/nom"),
      new_repo_name: z.string().regex(/^[\w.-]{1,100}$/).optional().describe("Nom d'un NOUVEAU dépôt privé à créer (au lieu de repo)"),
      instructions: z.string().min(10).max(4000).describe("Ce qu'il faut faire : bug à corriger, projet à créer, déploiement à lancer"),
      base_branch: z.string().max(100).regex(/^[\w./-]+$/).optional(),
    },
    async ({ repo, new_repo_name, instructions, base_branch }) => {
      if (!repo && !new_repo_name) return ko("Indique repo (dépôt existant) ou new_repo_name (nouveau projet).");
      // Le compte GitHub connecté via LibreChat passe en premier ; l'ancien token saisi à la main reste un secours.
      const gh = (await linkedToken(userId)) || (ghToken && !ghToken.includes("{{") && ghToken.length >= 20 ? ghToken : "");
      if (!gh) {
        return ko(
          `GitHub n'est pas encore connecté pour cet utilisateur. Donne-lui ce lien tel quel pour connecter son compte GitHub (une seule fois, valable 30 minutes), puis il pourra redemander sa tâche : ${connectLink(userId)}`
        );
      }
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
      return ok(`Tâche ${r.id} lancée. Le conteneur se détruit seul à la fin. Dire à l'utilisateur de demander le statut plus tard (get_job, job_id=${r.id}).`);
    }
  );

  s.tool(
    "get_job",
    "Statut d'une tâche (running, success, failed), résumé, branche, lien de la pull request et tokens consommés.",
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
      return ok(JSON.stringify({ job_id: j.id, repo: j.repo, status: j.status, summary: j.summary, branch: j.branch, pull_request: j.pr_url, tokens_used: j.tokens_used }));
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
