const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

// Chaque utilisateur a SON dev : son token GitHub, ses dépôts, son espace de travail.
const SECRET = process.env.MCP_SECRET || '';
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '3', 10);
const MAX_PER_DAY = parseInt(process.env.MAX_FIX_PER_DAY || '20', 10);
const DATA = '/data/repos';
const MAX_FILES = 3;
const MAX_CHARS = 12000;

const SYN = {
  paiement: ['pay', 'paiement', 'payment', 'fedapay', 'checkout'],
  payment: ['pay', 'paiement', 'payment', 'fedapay', 'checkout'],
  connexion: ['login', 'auth', 'signin', 'connexion'],
  login: ['login', 'auth', 'signin', 'connexion'],
  retrait: ['withdraw', 'retrait', 'payout'],
  email: ['mail', 'email', 'smtp'],
};
const STOP = new Set(['dans', 'avec', 'pour', 'mais', 'une', 'des', 'les', 'que', 'qui', 'pas', 'sur', 'mon', 'ton', 'est', 'the', 'and', 'problème', 'probleme', 'bug', 'erreur']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const b64 = (token) => Buffer.from('x-access-token:' + token).toString('base64');
const git = (args, cwd, token) =>
  run('git', [...(token ? ['-c', 'http.extraHeader=Authorization: Basic ' + b64(token)] : []), ...args], { cwd, maxBuffer: 20 * 1024 * 1024 });
const scrub = (text, token) => String(text).split(token).join('***').split(b64(token)).join('***');
const gh = (token, p, opts = {}) =>
  fetch('https://api.github.com' + p, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'dev-fix', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  }).then((r) => r.json());

// --- limites : parallèle global, un travail à la fois par utilisateur, plafond par jour ---
let running = 0;
const waiters = [];
async function acquire() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise((r) => waiters.push(r));
  running++;
}
function release() {
  running--;
  const next = waiters.shift();
  if (next) next();
}
const busyUsers = new Set();
const daily = new Map();

function cleanup() {
  try {
    const now = Date.now();
    for (const u of fs.readdirSync(DATA))
      for (const o of fs.readdirSync(path.join(DATA, u)))
        for (const r of fs.readdirSync(path.join(DATA, u, o))) {
          const d = path.join(DATA, u, o, r);
          if (now - fs.statSync(d).mtimeMs > 3 * 864e5) fs.rmSync(d, { recursive: true, force: true });
        }
  } catch (e) {
    /* rien à nettoyer */
  }
}

function keywords(problem) {
  const words = problem
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
  const out = new Set();
  for (const w of words) {
    out.add(w);
    (SYN[w] || []).forEach((s) => out.add(s));
  }
  return [...out].slice(0, 12);
}

async function sync(dir, owner, repo, token) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['clone', '--depth', '50', `https://github.com/${owner}/${repo}.git`, dir], undefined, token);
  } else {
    await git(['fetch', 'origin', '--depth', '50'], dir, token);
  }
  const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir)).stdout.trim();
  const base = ref.replace('refs/remotes/origin/', '');
  await git(['checkout', '-f', '--detach', 'origin/' + base], dir);
  await git(['clean', '-fd'], dir);
  return base;
}

async function findFiles(dir, kws) {
  const re = kws.map(esc).join('|');
  const scores = {};
  try {
    const { stdout } = await git(['grep', '-c', '-i', '-I', '-E', re, '--', '.', ':(exclude)*lock*', ':(exclude)*.min.*'], dir);
    for (const line of stdout.split('\n')) {
      const i = line.lastIndexOf(':');
      if (i > 0) scores[line.slice(0, i)] = parseInt(line.slice(i + 1), 10) || 0;
    }
  } catch (e) {
    /* aucun résultat */
  }
  const { stdout: ls } = await git(['ls-files'], dir);
  const nameRe = new RegExp(re, 'i');
  for (const f of ls.split('\n')) if (f && nameRe.test(f)) scores[f] = (scores[f] || 0) + 5;
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES)
    .map(([p]) => p);
}

async function ask(problem, files) {
  const body = {
    model: DS_MODEL,
    temperature: 0,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Tu es un développeur expert. On te donne un problème et des extraits de fichiers. Réponds en JSON strict : {"explanation":"2 phrases","edits":[{"file":"chemin","search":"texte EXACT existant, court mais unique","replace":"nouveau texte"}]}. Modifie le minimum de lignes. Si tu ne peux pas corriger avec ces fichiers, mets edits=[] et explique quel fichier il faudrait voir.',
      },
      {
        role: 'user',
        content: `Problème : ${problem}\n\n` + files.map((f) => `### ${f.path}\n${f.text}`).join('\n\n'),
      },
    ],
  };
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DS_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

async function devFix(ctx, repoArg, problem) {
  const token = ctx.token;
  if (!token) return 'Ton token GitHub est manquant : ouvre les réglages de l\'outil dev-fix dans LibreChat et saisis-le.';
  if (!DS_KEY) return 'DEEPSEEK_API_KEY manquant dans .env du serveur.';
  if (!problem) return 'Décris le problème en une ou deux phrases.';
  const me = await gh(token, '/user');
  if (!me.login) return 'Token GitHub invalide ou expiré.';
  const parts = repoArg.includes('/') ? repoArg.split('/') : [me.login, repoArg];
  const [owner, repo] = parts;
  if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo || '')) return 'Nom de dépôt invalide (forme : nom ou proprietaire/nom).';

  const userKey = crypto.createHash('sha256').update(ctx.userId || token).digest('hex').slice(0, 16);
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = userKey + ':' + day;
  if ((daily.get(dayKey) || 0) >= MAX_PER_DAY) return `Limite atteinte : ${MAX_PER_DAY} corrections par jour. Reviens demain.`;
  if (busyUsers.has(userKey)) return 'Une de tes corrections est déjà en cours, attends qu\'elle finisse.';

  busyUsers.add(userKey);
  await acquire();
  try {
    daily.set(dayKey, (daily.get(dayKey) || 0) + 1);
    cleanup();
    const dir = path.join(DATA, userKey, owner, repo);
    const base = await sync(dir, owner, repo, token);
    fs.utimesSync(dir, new Date(), new Date());
    const kws = keywords(problem);
    const names = await findFiles(dir, kws);
    if (names.length === 0) return `Aucun fichier trouvé pour : ${kws.join(', ')}. Reformule avec un mot du code (ex : fedapay, login).`;
    const files = names.map((p) => ({ path: p, text: fs.readFileSync(path.join(dir, p), 'utf8').slice(0, MAX_CHARS) }));
    const answer = await ask(problem, files);
    const applied = [];
    const failed = [];
    for (const e of answer.edits || []) {
      if (!names.includes(e.file)) {
        failed.push(e.file);
        continue;
      }
      const full = path.join(dir, e.file);
      const content = fs.readFileSync(full, 'utf8');
      if (e.search && content.split(e.search).length === 2) {
        fs.writeFileSync(full, content.replace(e.search, () => e.replace));
        applied.push(e.file);
      } else {
        failed.push(e.file);
      }
    }
    if (applied.length === 0) {
      return `${answer.explanation || ''}\nAucune modification appliquée. Fichiers regardés : ${names.join(', ')}.`;
    }
    const branch = 'devfix/' + Date.now();
    await git(['checkout', '-b', branch], dir);
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=dev-fix', '-c', 'user.email=dev-fix@users.noreply.github.com', 'commit', '-m', 'dev-fix: ' + problem.slice(0, 60)], dir);
    await git(['push', 'origin', branch], dir, token);
    const pr = await gh(token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: 'dev-fix: ' + problem.slice(0, 60), head: branch, base, body: answer.explanation || '' }),
    });
    return `${answer.explanation || ''}\nFichiers modifiés : ${applied.join(', ')}${failed.length ? '\nNon appliqués : ' + failed.join(', ') : ''}\nPull request : ${pr.html_url || scrub(JSON.stringify(pr).slice(0, 200), token)}`;
  } catch (e) {
    return 'Erreur : ' + scrub(String(e.stderr || e.message || e).slice(0, 300), token);
  } finally {
    busyUsers.delete(userKey);
    release();
  }
}

const TOOLS = [
  {
    name: 'dev_fix',
    description:
      'Corrige un bug dans un de TES dépôts GitHub : cherche les fichiers concernés, propose la correction et ouvre une pull request. Entrée : repo (nom du dépôt, ou proprietaire/nom), problem (le problème en une ou deux phrases).',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' }, problem: { type: 'string' } },
      required: ['repo', 'problem'],
    },
  },
];

http
  .createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      return res.end('ok');
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(405);
      return res.end();
    }
    if (SECRET && req.headers.authorization !== 'Bearer ' + SECRET) {
      res.writeHead(401);
      return res.end();
    }
    let raw = '';
    for await (const c of req) raw += c;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      res.writeHead(400);
      return res.end();
    }
    if (msg.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    let result;
    if (msg.method === 'initialize') {
      result = {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'dev-fix', version: '2.0.0' },
      };
    } else if (msg.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (msg.method === 'tools/call') {
      const a = (msg.params && msg.params.arguments) || {};
      const ctx = {
        token: String(req.headers['x-github-token'] || '').trim(),
        userId: String(req.headers['x-user-id'] || '').trim(),
      };
      const text = await devFix(ctx, String(a.repo || ''), String(a.problem || ''));
      result = { content: [{ type: 'text', text }] };
    } else {
      result = {};
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  })
  .listen(3000, () => console.log('dev-fix prêt sur :3000'));
