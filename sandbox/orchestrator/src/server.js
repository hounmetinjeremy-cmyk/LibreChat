import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Modèle à moteur unique : l'IA du chat pilote tout (outil execute_command). Le conteneur n'est qu'un
// exécuteur passif de commandes. Le clic sur Stop dans le chat annule la requête MCP en cours ; cet
// orchestrateur tue alors immédiatement le processus du conteneur (SIGTERM, puis SIGKILL côté worker).

// ------------------------------------------------------------------------------------ configuration
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
  region: e.SANDBOX_REGION || "ams",
  memoryMb: Number(e.SANDBOX_MEMORY_MB || 1024),
  sessionMaxSec: Number(e.SESSION_MAX_SEC || 3600), // durée maximale d'une session de terminal
  idleSec: Number(e.SESSION_IDLE_SEC || 600), // session fermée après 10 min sans commande
  perUserConcurrent: Number(e.MAX_CONCURRENT_PER_USER || 1),
  globalConcurrent: Number(e.MAX_CONCURRENT_GLOBAL || 4),
  sessionsPerDay: Number(e.DAILY_JOBS_PER_USER || 5),
  cmdDefaultSec: 120,
  tokensPerDay: Number(e.TOKENS_PER_USER_DAY || 3000000), // quota de tokens du chat par utilisateur et par jour
  // Doit rester inférieur au « timeout » du serveur sandbox dans librechat.yaml (200 s).
  cmdMaxSec: Math.max(5, Math.min(Number(e.CMD_MAX_SEC || 170), 190)),
};

// Clés de services (en-tête -> variable d'environnement du conteneur).
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
const svcFromParams = (p) => {
  const o = {};
  if (p.vercel_token) o.VERCEL_TOKEN = p.vercel_token;
  if (p.cloudflare_token) o.CLOUDFLARE_API_TOKEN = p.cloudflare_token;
  if (p.render_key) o.RENDER_API_KEY = p.render_key;
  if (p.fly_token) o.FLY_API_TOKEN = p.fly_token;
  return o;
};

// Garde-fou contre les boucles de recherche : 3 recherches de dépôts par utilisateur en 5 minutes.
const FIND_LOG = new Map();
function findAllowed(userId) {
  const now = Date.now();
  const arr = (FIND_LOG.get(userId) || []).filter((t) => now - t < 300000);
  if (arr.length >= 3) {
    FIND_LOG.set(userId, arr);
    return false;
  }
  arr.push(now);
  FIND_LOG.set(userId, arr);
  return true;
}

const tokenParam = (label) => z.string().min(8).max(500).regex(/^\S+$/).optional().describe(label);

// ------------------------------------------------------------------------------------ base de données
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
for (const col of ["activity TEXT", "tier TEXT", "expert_calls INTEGER NOT NULL DEFAULT 0", "cost_micro INTEGER NOT NULL DEFAULT 0"]) {
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`);
  } catch {}
}

const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rand = (n) => crypto.randomBytes(n).toString("hex");
const safeEq = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const ACTIVE = "('queued','running')";

// Tokens du jour par utilisateur (comptés par LibreChat, envoyés par POST /usage).
const dayTokens = (userId) => db.prepare("SELECT tokens FROM usage WHERE user_id=? AND day=?").get(userId, today())?.tokens || 0;
const addTokens = (userId, n) =>
  db.prepare("INSERT INTO usage (user_id,day,tokens) VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET tokens=tokens+?").run(userId, today(), n, n);
const quotaInfo = (userId) => {
  const used = dayTokens(userId);
  return { used, limit: C.tokensPerDay, remaining: Math.max(C.tokensPerDay - used, 0) };
};

// Une « tâche » (job) = une session de terminal. Journal d'activité lu par le panneau de suivi du chat.
function addActivity(id, line) {
  const l = String(line).replace(/\s+/g, " ").trim().slice(0, 200);
  if (!l) return;
  const j = db.prepare("SELECT activity FROM jobs WHERE id=?").get(id);
  const next = (j && j.activity ? `${j.activity}\n` : "") + l;
  db.prepare("UPDATE jobs SET activity=? WHERE id=?").run(next.slice(-3000), id);
}
function finish(id, status, summary) {
  db.prepare(`UPDATE jobs SET status=?, summary=?, finished_at=? WHERE id=? AND status IN ${ACTIVE}`).run(
    status,
    String(summary || "").slice(0, 2000),
    Date.now(),
    id
  );
}
const scrubWith = (secrets, text) => {
  let t = String(text);
  for (const v of secrets) if (v && v.length >= 8) t = t.split(v).join("***");
  return t;
};

// ------------------------------------------------------------------------------------ GitHub (via LibreChat)
const hmac = (s) => crypto.createHmac("sha256", C.secret).update(s).digest("hex");
function connectLink(userId) {
  const exp = Date.now() + 30 * 60000;
  return `${C.libreUrl}/api/github-link/start?u=${encodeURIComponent(userId)}&e=${exp}&s=${hmac(`${userId}.${exp}`)}`;
}
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
// 1) compte connecté via LibreChat, 2) token envoyé dans le chat, 3) ancien en-tête X-GitHub-Token.
async function pickGithub(userId, chatToken, headerToken) {
  const linked = await linkedToken(userId);
  if (linked) return linked;
  for (const t of [chatToken, headerToken]) {
    if (t && !t.includes("{{") && t.length >= 20) return t;
  }
  return "";
}
const githubMissing = (userId, then) =>
  `GitHub n'est pas encore connecté pour cet utilisateur. Écris une phrase courte puis affiche ce lien tel quel : [Jérémy Code](${connectLink(userId)}). En appuyant dessus, l'utilisateur connecte son compte GitHub et c'est fini (lien valable 30 minutes). Ne propose pas de token. Quand il a terminé, rappelle ${then}.`;

// ------------------------------------------------------------------------------------ Cloudflare (via LibreChat)
const CF_DEPLOY_NOTE =
  "Cloudflare est connecté (clés déjà dans l'environnement, ne les affiche jamais). Déploiement Pages : construis le projet (npm run build), puis lance « npx wrangler pages deploy ./dist --project-name=NOM --branch=main --commit-dirty=true » en remplaçant ./dist par le vrai dossier de sortie (dist, build ou out) et NOM par le nom du projet (minuscules, chiffres, tirets). Donne l'adresse https://NOM.pages.dev.";
const CF_MISSING_NOTE =
  "Cloudflare n'est pas connecté pour cet utilisateur : si la tâche demande un déploiement Cloudflare, ne tente rien et dis-lui de connecter son compte Cloudflare avec le bouton prévu.";
const CF_INVALID_NOTE =
  "Le jeton Cloudflare de l'utilisateur est invalide ou révoqué : si un déploiement Cloudflare est prévu, écris une phrase courte puis affiche exactement ce lien Markdown : [Connecter Cloudflare](#cloudflare-connect). ";
async function cloudflareEnv(userId) {
  try {
    const r = await fetch(`${C.libreUrl}/api/cloudflare-link/credentials?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${C.secret}` },
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return d && d.reconnect ? { invalid: true } : null;
    if (typeof d.token === "string" && d.token.length >= 20 && /^[a-f0-9]{32}$/i.test(String(d.account_id))) {
      return { env: { CLOUDFLARE_API_TOKEN: d.token, CLOUDFLARE_ACCOUNT_ID: String(d.account_id) } };
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------ recherche de dépôts
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
const sim = (a, b) => {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.85;
  return Math.max(0, 1 - lev(a, b) / Math.max(a.length, b.length));
};
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

// ------------------------------------------------------------------------------------ API Fly Machines
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
async function killMachine(id) {
  try {
    await fly("DELETE", `/machines/${id}?force=true`);
  } catch (err) {
    if (!/404/.test(err.message)) console.error("kill:", err.message);
  }
}

// ------------------------------------------------------------------------------------ sessions de terminal
// État vivant en mémoire (la base ne garde que le statut, les quotas et le journal d'activité).
const SESS = new Map(); // id de session -> objet session
const INFLIGHT = new Map(); // `${userId}:${id JSON-RPC}` -> AbortController de l'appel MCP en cours
const userSession = (userId) => {
  for (const s of SESS.values()) if (s.userId === userId && !s.closed) return s;
  return null;
};

function reserveSession(userId) {
  const day = today();
  return db.transaction(() => {
    const u = db.prepare("SELECT jobs FROM usage WHERE user_id=? AND day=?").get(userId, day) || { jobs: 0 };
    if (u.jobs >= C.sessionsPerDay) return { error: `Quota atteint : ${C.sessionsPerDay} sessions de terminal par jour.` };
    const mine = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE user_id=? AND status IN ${ACTIVE}`).get(userId).n;
    if (mine >= C.perUserConcurrent) return { error: "Une session de terminal est déjà ouverte pour toi." };
    const all = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status IN ${ACTIVE}`).get().n;
    if (all >= C.globalConcurrent) return { error: "Serveur occupé, réessaie dans quelques minutes." };
    const id = rand(6);
    const token = rand(32);
    db.prepare(
      "INSERT INTO jobs (id,user_id,repo,base,instructions,token_hash,status,created_at,tier) VALUES (?,?,?,?,?,?,'queued',?,?)"
    ).run(id, userId, "(terminal)", null, "session de terminal", sha(token), Date.now(), "aube");
    db.prepare("INSERT INTO usage (user_id,day,jobs) VALUES (?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET jobs=jobs+1").run(userId, day);
    return { id, token };
  })();
}

async function openSession(userId) {
  const r = reserveSession(userId);
  if (r.error) return r;
  const s = {
    id: r.id,
    userId,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    lastSeen: 0,
    booted: false,
    closed: false,
    machineId: null,
    queue: [], // commandes en attente d'être prises par le worker
    cmds: new Set(), // toutes les commandes non terminées
    poll: null, // requête /internal/next en attente
    watches: new Map(), // id de commande -> requête /internal/watch en attente
    cancelled: new Set(),
    stuck: null, // commande annulée dont le worker n'a pas encore confirmé la mort
    killTimer: null,
    secrets: new Set(),
    gh: "",
    ghAt: 0,
    cf: null,
    cfAt: 0,
  };
  SESS.set(s.id, s);
  try {
    const m = await fly("POST", "/machines", {
      name: `job-${s.id}`,
      region: C.region,
      config: {
        image: C.image,
        auto_destroy: true,
        restart: { policy: "no" },
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: C.memoryMb },
        env: { JOB_TOKEN: r.token, ORCHESTRATOR_URL: C.publicUrl, MAX_RUNTIME_SEC: String(C.sessionMaxSec) },
        metadata: { job_id: s.id, user_id: userId },
      },
    });
    s.machineId = m.id;
    db.prepare("UPDATE jobs SET machine_id=?, status='running' WHERE id=?").run(m.id, s.id);
  } catch (err) {
    console.error("launch:", err.message);
    await endSession(s, "failed", "Échec du démarrage du conteneur.", true);
    db.prepare("UPDATE usage SET jobs=MAX(jobs-1,0) WHERE user_id=? AND day=?").run(userId, today());
    return { error: "Impossible de démarrer le conteneur pour le moment." };
  }
  return { s };
}

async function endSession(s, status, summary, hard = false) {
  if (s.closed) return;
  s.closed = true;
  SESS.delete(s.id);
  clearTimeout(s.killTimer);
  for (const c of [...s.cmds]) c.finish({ closed: true });
  s.queue = [];
  if (s.poll) {
    clearTimeout(s.poll.timer);
    try {
      s.poll.res.json({ stop: true });
    } catch {}
    s.poll = null;
  }
  for (const res of s.watches.values()) {
    try {
      res.json({ cancel: true });
    } catch {}
  }
  s.watches.clear();
  finish(s.id, status, summary);
  if (s.machineId) {
    if (hard) await killMachine(s.machineId);
    else setTimeout(() => killMachine(s.machineId), 3000); // laisse le worker se terminer proprement
  }
}

// Remet la prochaine commande au worker (avec les clés de la commande, jamais conservées côté worker).
function takeNext(s) {
  const c = s.queue.shift();
  if (!c) return null;
  c.taken = true;
  return { cmd: { id: c.id, command: c.command, cwd: c.cwd, timeout: c.timeout }, env: c.env };
}
function wake(s) {
  if (!s.poll) return;
  const p = takeNext(s);
  if (!p) return;
  clearTimeout(s.poll.timer);
  const res = s.poll.res;
  s.poll = null;
  res.json(p);
}

// ARRÊT : appelé quand le chat annule l'appel (Stop, connexion coupée) ou quand le délai est dépassé.
function cancelCmd(s, c, why) {
  if (c.done) return;
  if (!c.taken) {
    // jamais parti vers le conteneur : on la retire simplement de la file
    c.finish({ cancelled: true, why });
    return;
  }
  c.cancelRequested = true;
  s.cancelled.add(c.id);
  const w = s.watches.get(c.id);
  if (w) {
    s.watches.delete(c.id);
    try {
      w.json({ cancel: true }); // le worker tue aussitôt le groupe de processus (SIGTERM puis SIGKILL)
    } catch {}
  }
  addActivity(s.id, "Arrêt demandé : commande interrompue");
  s.stuck = c.id;
  clearTimeout(s.killTimer);
  // Filet de sécurité : si le worker ne confirme pas en 8 s, on détruit le conteneur.
  s.killTimer = setTimeout(() => {
    if (s.stuck && !s.closed) {
      addActivity(s.id, "Conteneur arrêté de force");
      endSession(s, "failed", "Session arrêtée de force (commande bloquée).", true);
    }
  }, 8000);
  c.finish({ cancelled: true, why });
}

function runCommand(s, spec, signal, extra) {
  return new Promise((resolve) => {
    const c = { id: rand(4), ...spec, taken: false, done: false, cancelRequested: false };
    s.cmds.add(c);
    const progressToken = extra && extra._meta ? extra._meta.progressToken : undefined;
    let ticks = 0;
    const ping = setInterval(() => {
      if (progressToken !== undefined && extra && extra.sendNotification) {
        extra
          .sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++ticks, message: "commande en cours" } })
          .catch(() => {});
      }
    }, 20000);
    const onAbort = () => cancelCmd(s, c, "abort");
    // Filet : le worker ne répond pas du tout (délai + marge)
    const backstop = setTimeout(() => cancelCmd(s, c, "backstop"), (spec.timeout + 25) * 1000);
    c.finish = (r) => {
      if (c.done) return;
      c.done = true;
      clearInterval(ping);
      clearTimeout(backstop);
      signal.removeEventListener("abort", onAbort);
      s.cmds.delete(c);
      s.queue = s.queue.filter((x) => x !== c);
      s.lastUsed = Date.now();
      resolve(r);
    };
    s.lastUsed = Date.now();
    s.queue.push(c);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    wake(s);
  });
}

// Clés passées à CHAQUE commande (GitHub et Cloudflare peuvent être connectés en cours de session).
async function commandEnv(s, args, ghHeader, svcHeaders) {
  const now = Date.now();
  if (args.github_token || now - s.ghAt > 30000) {
    s.gh = (await pickGithub(s.userId, args.github_token, ghHeader)) || "";
    s.ghAt = now;
  }
  const svc = { ...svcHeaders, ...svcFromParams(args) };
  if (!svc.CLOUDFLARE_API_TOKEN && now - s.cfAt > 120000) {
    s.cf = await cloudflareEnv(s.userId);
    s.cfAt = now;
  }
  const env = { ...svc };
  if (s.cf && s.cf.env) Object.assign(env, s.cf.env);
  if (s.gh) {
    env.GH_TOKEN = s.gh;
    env.GITHUB_TOKEN = s.gh;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${s.gh}`).toString("base64")}`;
  }
  for (const v of Object.values(env)) if (typeof v === "string" && v.length >= 8) s.secrets.add(v);
  return env;
}

// Résumé des sorties de commandes, sans IA et sans coût : retire les codes de couleur, les barres de progression
// et les lignes répétées. Jusqu'à 6000 caractères, la sortie est renvoyée entière ; au-delà, on garde le début,
// les lignes d'erreur et la fin, avec le nombre de lignes omises.
const compact = (text) => {
  const clean = String(text)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
  const lines = [];
  let last = "";
  let repeat = 0;
  const flush = () => {
    if (repeat > 0) lines.push("(ligne répétée " + repeat + " fois)");
    repeat = 0;
  };
  for (const raw of clean.split("\n")) {
    const l = raw.replace(/\s+$/, "");
    if (!l.trim()) continue;
    if (/^[\s\[\(#=>.\-|\\\/]{5,}\]?\s*\d*%?\s*$/.test(l) || /\d+%\s*[|\[#=]/.test(l)) continue;
    if (l === last) {
      repeat += 1;
      continue;
    }
    flush();
    lines.push(l);
    last = l;
  }
  flush();
  const full = lines.join("\n");
  if (full.length <= 6000) return full;
  const bad = /error|erreur|ERR!|failed|fatal|exception|traceback|cannot|not found|denied|ENOENT|EACCES|warn/i;
  const head = lines.slice(0, 8);
  const tail = lines.slice(-20);
  const middle = lines.slice(8, -20);
  const important = middle.filter((l) => bad.test(l)).slice(0, 12);
  const omitted = middle.length - important.length;
  const out =
    head.join("\n") +
    "\n...[" + omitted + " lignes omises : utilise grep, head ou tail pour en voir plus]...\n" +
    (important.length ? important.join("\n") + "\n...\n" : "") +
    tail.join("\n");
  return out.length > 4500 ? out.slice(0, 1500) + "\n...[tronqué]...\n" + out.slice(-3000) : out;
};

const ok = (t) => ({ content: [{ type: "text", text: t }] });
const ko = (t) => ({ content: [{ type: "text", text: t }], isError: true });
const clip = (t, n = 6000) => (t.length > n ? `${t.slice(0, 3000)}\n...[tronqué]...\n${t.slice(-(n - 3000))}` : t);

// ------------------------------------------------------------------------------------ serveur MCP (LibreChat)
function buildServer(userId, ghHeader, svcHeaders, reqSignal, userRole) {
  const s = new McpServer(
    { name: "fly-sandboxes", version: "3.0.0" },
    {
      instructions:
        "Terminal Linux jetable. Tu le pilotes toi-même avec execute_command (une commande bash par appel, dossier /work). Si l'utilisateur clique sur Stop, la commande en cours est tuée immédiatement : ne la relance pas.",
    }
  );

  s.tool(
    "find_repos",
    "Cherche parmi les dépôts GitHub de l'utilisateur (publics et privés) ceux qui ressemblent à un nom ou à des mots-clés, même approximatifs ou mal orthographiés. À appeler AVANT de cloner dès que l'utilisateur ne donne pas le nom exact propriétaire/nom. Retourne une courte liste à proposer à l'utilisateur pour confirmation. Si l'utilisateur t'a envoyé un token GitHub dans le chat, passe-le dans github_token.",
    {
      query: z.string().min(2).max(100).describe("Nom approximatif ou mots-clés du projet, tels que l'utilisateur les a écrits"),
      github_token: tokenParam("Token GitHub envoyé par l'utilisateur dans le chat (seulement s'il n'a pas connecté son compte)"),
    },
    async ({ query, github_token }) => {
      const gh = await pickGithub(userId, github_token, ghHeader);
      if (!gh) return ko(githubMissing(userId, "find_repos"));
      if (!findAllowed(userId)) {
        return ko("Trop de recherches de dépôts d'affilée. Arrête de chercher : demande à l'utilisateur le nom exact (propriétaire/nom) et attends sa réponse.");
      }
      try {
        const repos = await searchRepos(gh, query);
        if (!repos.length) return ok(`Aucun dépôt ne ressemble à « ${query.slice(0, 100)} ». Demande à l'utilisateur de préciser le nom du projet.`);
        return ok(`${JSON.stringify(repos)}\nPropose ces dépôts à l'utilisateur et attends son choix : ne relance pas find_repos et ne cite pas d'autres projets.`);
      } catch (err) {
        console.error("find_repos:", err.message);
        return ko("Impossible de lire les dépôts GitHub pour le moment. Si l'utilisateur a envoyé un token, il est peut-être invalide ou sans accès à ses dépôts.");
      }
    }
  );

  s.tool(
    "execute_command",
    "Exécute UNE commande bash dans un terminal Linux isolé et jetable (le conteneur s'ouvre tout seul à la première commande et reste ouvert entre les appels : fichiers et dépôts clonés persistent dans /work). Chaque appel démarre un bash neuf depuis /work : utilise cwd ou « cd dossier && ... » (le cd ne persiste pas). Tout se fait par commandes : git clone, cat/sed/heredoc pour lire et écrire des fichiers, npm install, tests, build, déploiements, git commit/push. GitHub est préconfiguré (git clone/push sur les dépôts de l'utilisateur, sans token à écrire). Les clés de services (Cloudflare, etc.) sont déjà dans l'environnement : ne les affiche jamais. Lis chaque résultat avant la commande suivante, une étape à la fois. Si l'utilisateur clique sur Stop, la commande en cours est tuée immédiatement.",
    {
      command: z.string().min(1).max(8000).describe("La commande bash à exécuter (une étape à la fois)"),
      cwd: z
        .string()
        .max(200)
        .regex(/^[\w.\-/]*$/)
        .optional()
        .describe("Sous-dossier de /work où lancer la commande, par exemple le nom du dépôt cloné"),
      timeout_seconds: z.number().int().min(1).max(C.cmdMaxSec).optional().describe(`Durée maximale en secondes (défaut ${C.cmdDefaultSec}, max ${C.cmdMaxSec}). Au-delà, la commande est tuée.`),
      github_token: tokenParam("Token GitHub envoyé par l'utilisateur dans le chat (seulement s'il n'a pas connecté son compte)"),
      vercel_token: tokenParam("Clé Vercel envoyée par l'utilisateur dans le chat, si la commande déploie sur Vercel"),
      cloudflare_token: tokenParam("Clé Cloudflare envoyée par l'utilisateur dans le chat, en dernier recours"),
      render_key: tokenParam("Clé Render envoyée par l'utilisateur dans le chat, si la commande utilise Render"),
      fly_token: tokenParam("Clé Fly.io envoyée par l'utilisateur dans le chat, si la commande utilise Fly.io"),
    },
    async (args, extra) => {
      // Un seul signal d'annulation : arrêt MCP du chat OU connexion HTTP coupée.
      const signal = AbortSignal.any([reqSignal, ...(extra && extra.signal ? [extra.signal] : [])]);
      if (signal.aborted) return ko("Annulé.");
      if (userRole !== "ADMIN" && quotaInfo(userId).remaining <= 0) {
        return ko("Le quota de tokens du jour de cet utilisateur est épuisé. Il se renouvelle demain. Dis-le en une phrase et arrête-toi : ne lance plus de commande.");
      }
      const command = String(args.command || "").trim();
      if (!command) return ko("command est vide.");
      const cwd = String(args.cwd || "");
      if (cwd.split("/").includes("..")) return ko("cwd invalide.");
      const timeout = Math.min(Math.max(Math.floor(Number(args.timeout_seconds) || C.cmdDefaultSec), 1), C.cmdMaxSec);

      let sess = userSession(userId);
      let fresh = false;
      if (!sess) {
        const o = await openSession(userId);
        if (o.error) return ko(o.error);
        sess = o.s;
        fresh = true;
      }
      const sx = sess;
      const abandon = async () => {
        if (fresh) await endSession(sx, "success", "Annulée avant la première commande.", true);
        return ko("Annulé.");
      };
      if (signal.aborted) return abandon();
      const env = await commandEnv(sx, args, ghHeader, svcHeaders);
      if (signal.aborted) return abandon();

      addActivity(sx.id, `$ ${scrubWith(sx.secrets, command).slice(0, 150)}`);
      const r = await runCommand(sx, { command, cwd, timeout, env }, signal, extra);

      if (r.cancelled) return ko("Commande interrompue : arrêt demandé, le processus a été tué. Ne la relance pas sauf si l'utilisateur le demande.");
      if (r.closed) return ko("La session de terminal s'est fermée pendant la commande. La prochaine commande en ouvrira une nouvelle (les fichiers sont perdus).");
      const out = clip(compact(scrubWith(sx.secrets, r.out || ""))).trim();
      addActivity(sx.id, `→ code ${r.timedOut ? "délai dépassé" : r.code}`);

      let head = r.timedOut ? `Délai dépassé (${timeout} s), processus tué.` : `code ${r.code === null || r.code === undefined ? `signal ${r.signal}` : r.code}`;
      let note = "";
      if (fresh) {
        const parts = [`Tâche ${sx.id} lancée. Session de terminal ouverte (conteneur jetable, dossier /work).`];
        parts.push(sx.gh ? "GitHub connecté." : "GitHub non connecté (utile seulement si la tâche touche un dépôt).");
        if (sx.cf && sx.cf.env) parts.push(CF_DEPLOY_NOTE);
        else parts.push(sx.cf && sx.cf.invalid ? CF_INVALID_NOTE : CF_MISSING_NOTE);
        note = `${parts.join(" ")}\n`;
      }
      let hint = "";
      if (!sx.gh && /could not read Username|Authentication failed|terminal prompts disabled|Repository not found/i.test(out)) {
        hint = `\n\n${githubMissing(userId, "la commande")}`;
      }
      return ok(`${note}${head}\n${out || "(aucune sortie)"}${hint}`);
    }
  );

  s.tool("close_session", "Ferme le terminal et détruit le conteneur (les fichiers sont perdus). À appeler quand le travail est terminé. Facultatif : il se ferme aussi tout seul après 10 minutes sans commande.", {}, async () => {
    const sess = userSession(userId);
    if (!sess) return ok("Aucune session ouverte.");
    await endSession(sess, "success", "Session fermée.");
    return ok("Session fermée, conteneur détruit.");
  });

  s.tool("my_quota", "Sessions de terminal restantes pour l'utilisateur aujourd'hui.", {}, async () => {
    const u = db.prepare("SELECT jobs FROM usage WHERE user_id=? AND day=?").get(userId, today()) || { jobs: 0 };
    const sess = userSession(userId);
    return ok(
      JSON.stringify({
        sessions_restantes: Math.max(C.sessionsPerDay - u.jobs, 0),
        tokens_restants: userRole === "ADMIN" ? C.tokensPerDay : quotaInfo(userId).remaining,
        admin: userRole === "ADMIN",
        tokens_max_jour: C.tokensPerDay,
        tokens_utilises: quotaInfo(userId).used,
        session_ouverte: Boolean(sess),
        fermeture_automatique_apres_s: C.idleSec,
        duree_max_commande_s: C.cmdMaxSec,
      })
    );
  });

  s.tool(
    "link_pages",
    "Relie un dépôt GitHub de l'utilisateur à Cloudflare Pages : chaque push sur la branche principale republie le site automatiquement. À appeler après un push réussi qui a créé ou modifié un site. L'utilisateur n'a rien à fournir : Cloudflare doit seulement être connecté.",
    {
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe("Dépôt GitHub : propriétaire/nom"),
      project_name: z.string().max(58).optional().describe("Nom du site (lettres minuscules, chiffres, tirets) ; par défaut le nom du dépôt"),
      build_command: z.string().max(200).optional().describe("Commande de build, par défaut npm run build"),
      output_dir: z.string().max(100).optional().describe("Dossier de sortie du build, par défaut dist"),
    },
    async ({ repo, project_name, build_command, output_dir }) => {
      const [owner, name] = repo.split("/");
      try {
        const r = await fetch(`${C.libreUrl}/api/cloudflare-link/pages/project`, {
          method: "POST",
          headers: { Authorization: `Bearer ${C.secret}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            user: userId,
            owner,
            repo: name,
            name: project_name || name,
            build_command: build_command || undefined,
            destination_dir: output_dir || undefined,
          }),
          signal: AbortSignal.timeout(60000),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          return ok(
            JSON.stringify({
              site: d.url,
              projet: d.project,
              republie_a_chaque_modification: d.auto_deploy_on_push !== false,
              premier_build_lance: Boolean(d.first_build_started),
              consigne: "Donne l'adresse du site en une phrase. Le premier build peut prendre une ou deux minutes.",
            })
          );
        }
        if (d.error === "cloudflare_not_connected" || d.reconnect) {
          return ko("Cloudflare n'est pas connecté (ou le jeton n'est plus valide). Écris une phrase courte puis affiche exactement ce lien Markdown : [Connecter Cloudflare](#cloudflare-connect). Quand l'utilisateur a terminé, rappelle link_pages.");
        }
        if (d.error === "github_app_missing") {
          return ko(`Cloudflare doit avoir accès au dépôt GitHub (une seule fois). Dis-le en une phrase et affiche ce lien tel quel : [Autoriser Cloudflare sur GitHub](${d.authorize_url || "https://dash.cloudflare.com"}). Quand c'est fait, rappelle link_pages.`);
        }
        if (d.error === "rate_limited") return ko("Cloudflare demande de patienter un instant. Dis-le en une phrase et rappelle link_pages dans une minute.");
        return ko(`Cloudflare : ${String(d.message || "erreur").slice(0, 300)}`);
      } catch (err) {
        console.error("link_pages:", err.message);
        return ko("Cloudflare est injoignable pour le moment.");
      }
    }
  );

  return s;
}

// ------------------------------------------------------------------------------------ HTTP
const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));

function mcpAuth(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m || !safeEq(m[1], C.secret)) return res.status(401).json({ error: "non autorisé" });
  const user = String(req.headers["x-user-id"] || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(user)) return res.status(400).json({ error: "X-User-Id invalide" });
  req.userId = user;
  req.userRole = String(req.headers['x-user-role'] || '').toUpperCase();
  next();
}

// Suivi en direct pour l'interface LibreChat (route /api/sandbox-job) : un utilisateur ne voit que ses sessions.
app.get("/jobs/:id", mcpAuth, (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: "tâche invalide" });
  const j = db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?").get(req.params.id, req.userId);
  if (!j) return res.status(404).json({ error: "tâche introuvable" });
  const running = j.status === "queued" || j.status === "running";
  res.set("Cache-Control", "no-store").json({
    job_id: j.id,
    repo: j.repo,
    status: j.status,
    running,
    summary: j.summary,
    branch: j.branch,
    pull_request: j.pr_url,
    tokens_used: j.tokens_used,
    cost_usd: 0,
    tier: j.tier,
    activity: String(j.activity || "").split("\n").filter(Boolean).slice(-40),
    created_at: j.created_at,
    finished_at: j.finished_at,
  });
});

// Quota de tokens : lu et alimenté par LibreChat (même identité que le serveur MCP).
app.get("/quota", mcpAuth, (req, res) => {
  res.set("Cache-Control", "no-store").json(quotaInfo(req.userId));
});
app.post("/usage", mcpAuth, express.json({ limit: "4kb" }), (req, res) => {
  const n = Math.floor(Number(req.body && req.body.tokens));
  if (Number.isFinite(n) && n > 0 && n < 5000000) addTokens(req.userId, n);
  res.json(quotaInfo(req.userId));
});

// Arrêt explicite (en plus de l'annulation MCP) : tue la commande en cours de cet utilisateur.
app.post("/sessions/cancel", mcpAuth, (req, res) => {
  const s = userSession(req.userId);
  let n = 0;
  if (s) {
    for (const c of [...s.cmds]) {
      cancelCmd(s, c, "abort");
      n += 1;
    }
  }
  res.json({ cancelled: n });
});

app.post("/mcp", mcpAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const msgs = Array.isArray(req.body) ? req.body : [req.body];
  // En mode sans état, la notification « cancelled » du client arrive dans UNE AUTRE requête HTTP que
  // l'appel d'outil : on la relie ici à l'appel en cours pour l'annuler.
  for (const m of msgs) {
    if (m && m.method === "notifications/cancelled" && m.params && m.params.requestId !== undefined) {
      const ctlOther = INFLIGHT.get(`${req.userId}:${m.params.requestId}`);
      if (ctlOther) ctlOther.abort();
    }
  }
  const ctl = new AbortController();
  const keys = msgs.filter((m) => m && m.method === "tools/call" && m.id !== undefined).map((m) => `${req.userId}:${m.id}`);
  for (const k of keys) INFLIGHT.set(k, ctl);

  const server = buildServer(req.userId, String(req.headers["x-github-token"] || ""), svcFrom(req.headers), ctl.signal, req.userRole);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    for (const k of keys) if (INFLIGHT.get(k) === ctl) INFLIGHT.delete(k);
    // Connexion coupée avant la fin de la réponse (Stop, fermeture de l'appli) : annule la commande.
    if (!res.writableFinished) ctl.abort();
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

// --- routes internes (worker du conteneur) : le worker appelle l'orchestrateur, jamais l'inverse
function sessFromReq(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const j = db.prepare("SELECT id FROM jobs WHERE token_hash=?").get(sha(m[1]));
  const s = j ? SESS.get(j.id) : null;
  if (s) {
    s.lastSeen = Date.now();
    s.booted = true;
  }
  return s || null;
}

// Le worker attend ici sa prochaine commande (requête longue de 20 s au plus).
app.get("/internal/next", (req, res) => {
  const s = sessFromReq(req);
  if (!s) return res.status(401).json({ error: "jeton invalide" });
  if (s.closed) return res.json({ stop: true });
  if (s.stuck) {
    s.stuck = null; // le worker est revenu : la commande annulée est bien morte
    clearTimeout(s.killTimer);
  }
  if (s.poll) {
    clearTimeout(s.poll.timer);
    try {
      s.poll.res.json({ idle: true });
    } catch {}
    s.poll = null;
  }
  const p = takeNext(s);
  if (p) return res.json(p);
  const timer = setTimeout(() => {
    if (s.poll && s.poll.res === res) {
      s.poll = null;
      res.json({ idle: true });
    }
  }, 20000);
  s.poll = { res, timer };
  res.on("close", () => {
    if (s.poll && s.poll.res === res) {
      clearTimeout(timer);
      s.poll = null;
    }
  });
});

// Pendant une commande, le worker écoute ici : la réponse { cancel: true } part dès le clic sur Stop.
app.get("/internal/watch/:cid", (req, res) => {
  const s = sessFromReq(req);
  if (!s) return res.status(401).json({ error: "jeton invalide" });
  const cid = String(req.params.cid);
  if (s.cancelled.has(cid)) return res.json({ cancel: true });
  const c = [...s.cmds].find((x) => x.id === cid);
  if (!c || c.done) return res.json({ cancel: false, done: true });
  const old = s.watches.get(cid);
  if (old) {
    try {
      old.json({ cancel: false });
    } catch {}
  }
  const timer = setTimeout(() => {
    if (s.watches.get(cid) === res) {
      s.watches.delete(cid);
      res.json({ cancel: false });
    }
  }, 20000);
  s.watches.set(cid, res);
  res.on("close", () => {
    clearTimeout(timer);
    if (s.watches.get(cid) === res) s.watches.delete(cid);
  });
});

app.post("/internal/cmd/:cid", express.json({ limit: "256kb" }), (req, res) => {
  const s = sessFromReq(req);
  if (!s) return res.status(401).json({ error: "jeton invalide" });
  const cid = String(req.params.cid);
  s.cancelled.delete(cid);
  if (s.stuck === cid) {
    s.stuck = null;
    clearTimeout(s.killTimer);
  }
  const w = s.watches.get(cid);
  if (w) {
    s.watches.delete(cid);
    try {
      w.json({ cancel: false, done: true });
    } catch {}
  }
  const c = [...s.cmds].find((x) => x.id === cid);
  const b = req.body || {};
  if (c && !c.done) {
    c.finish({ code: b.code, signal: b.signal, timedOut: Boolean(b.timedOut), out: String(b.out || "") });
  }
  res.json({ ok: true });
});

// Filet de sécurité : sessions inactives ou trop longues, conteneurs morts ou orphelins.
async function sweep() {
  try {
    const now = Date.now();
    for (const s of [...SESS.values()]) {
      if (s.closed) continue;
      if (s.cmds.size === 0 && now - s.lastUsed > C.idleSec * 1000) {
        await endSession(s, "success", "Session inactive fermée.");
      } else if (now - s.createdAt > C.sessionMaxSec * 1000) {
        await endSession(s, "failed", "Durée maximale de session atteinte.", true);
      } else if (!s.booted && now - s.createdAt > 120000) {
        await endSession(s, "failed", "Le conteneur n'a pas démarré.", true);
      } else if (s.booted && now - s.lastSeen > 90000) {
        await endSession(s, "failed", "Le conteneur ne répond plus.", true);
      }
    }
    for (const j of db.prepare(`SELECT id, machine_id FROM jobs WHERE status IN ${ACTIVE}`).all()) {
      if (!SESS.has(j.id)) {
        if (j.machine_id) await killMachine(j.machine_id);
        finish(j.id, "failed", "Session interrompue.");
      }
    }
    const machines = await fly("GET", "/machines");
    for (const m of machines) {
      const id = m.config && m.config.metadata ? m.config.metadata.job_id : null;
      if (id && !SESS.has(id)) await killMachine(m.id);
    }
  } catch (err) {
    console.error("sweep:", err.message);
  }
}
setInterval(sweep, 30000);
sweep();

app.listen(C.port, "0.0.0.0", () => console.log(`Orchestrateur prêt sur :${C.port}`));
