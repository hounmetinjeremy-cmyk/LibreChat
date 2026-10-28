const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const OWNER = process.env.ALLOWED_OWNER || 'hounmetinjeremy-cmyk';
const SECRET = process.env.MCP_SECRET || '';
const GH = process.env.GITHUB_TOKEN || '';
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
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

const git = (args, cwd) => run('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

async function sync(repo) {
  const dir = path.join(DATA, repo);
  const url = `https://x-access-token:${GH}@github.com/${OWNER}/${repo}.git`;
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(DATA, { recursive: true });
    await run('git', ['clone', '--depth', '50', url, dir]);
  } else {
    await git(['remote', 'set-url', 'origin', url], dir);
    await git(['fetch', 'origin', '--depth', '50'], dir);
  }
  const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir)).stdout.trim();
  const base = ref.replace('refs/remotes/origin/', '');
  await git(['checkout', '-f', '--detach', 'origin/' + base], dir);
  await git(['clean', '-fd'], dir);
  return { dir, base };
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

let busy = false;

async function devFix(repo, problem) {
  if (!/^[\w.-]+$/.test(repo)) return 'Nom de dépôt invalide.';
  if (!GH || !DS_KEY) return 'GITHUB_TOKEN ou DEEPSEEK_API_KEY manquant dans .env.';
  if (busy) return 'Une correction est déjà en cours, réessaie dans une minute.';
  busy = true;
  try {
    const { dir, base } = await sync(repo);
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
    await git(['push', 'origin', branch], dir);
    const pr = await fetch(`https://api.github.com/repos/${OWNER}/${repo}/pulls`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + GH, 'Content-Type': 'application/json', 'User-Agent': 'dev-fix' },
      body: JSON.stringify({ title: 'dev-fix: ' + problem.slice(0, 60), head: branch, base, body: answer.explanation || '' }),
    }).then((r) => r.json());
    return `${answer.explanation || ''}\nFichiers modifiés : ${applied.join(', ')}${failed.length ? '\nNon appliqués : ' + failed.join(', ') : ''}\nPull request : ${pr.html_url || JSON.stringify(pr).slice(0, 200)}`;
  } catch (e) {
    return 'Erreur : ' + String(e.message || e).slice(0, 300);
  } finally {
    busy = false;
  }
}

const TOOLS = [
  {
    name: 'dev_fix',
    description:
      'Corrige un bug dans un dépôt GitHub : cherche les fichiers concernés, propose la correction et ouvre une pull request. Entrée : repo (nom du dépôt), problem (le problème en une ou deux phrases).',
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
        serverInfo: { name: 'dev-fix', version: '1.0.0' },
      };
    } else if (msg.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (msg.method === 'tools/call') {
      const a = (msg.params && msg.params.arguments) || {};
      const text = await devFix(String(a.repo || ''), String(a.problem || ''));
      result = { content: [{ type: 'text', text }] };
    } else {
      result = {};
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  })
  .listen(3000, () => console.log('dev-fix prêt sur :3000'));
