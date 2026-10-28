const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

// Agent de développement, un par utilisateur : son token GitHub, ses dépôts, son espace de travail
// et son budget de tokens par mois. Boucle côté serveur : chercher, lire, modifier, recommencer,
// puis pull request. Le chat n'appelle l'outil qu'une fois.
const SECRET = process.env.MCP_SECRET || '';
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '3', 10);
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '12', 10);
const FIX_BUDGET = parseFloat(process.env.FIX_BUDGET_USD || '1');
const PRICE_IN = parseFloat(process.env.DS_PRICE_IN || '0.14'); // dollars par million de tokens d'entrée
const PRICE_OUT = parseFloat(process.env.DS_PRICE_OUT || '0.28'); // dollars par million de tokens de sortie
const DATA = '/data/repos';
const USAGE_FILE = '/data/usage.json';

const b64 = (token) => Buffer.from('x-access-token:' + token).toString('base64');
const git = (args, cwd, token) =>
  run('git', [...(token ? ['-c', 'http.extraHeader=Authorization: Basic ' + b64(token)] : []), ...args], { cwd, maxBuffer: 20 * 1024 * 1024 });
const scrub = (text, token) => String(text).split(token).join('***').split(b64(token)).join('***');
const gh = (token, p, opts = {}) =>
  fetch('https://api.github.com' + p, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'dev-fix', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
  }).then((r) => r.json());

// --- budget de tokens par utilisateur et par mois (conservé dans /data/usage.json) ---
let usage = {};
try {
  usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
} catch (e) {
  usage = {};
}
const monthKey = () => new Date().toISOString().slice(0, 7);
const spent = (userKey) => (usage[userKey] && usage[userKey][monthKey()]) || 0;
function addSpent(userKey, usd) {
  const m = monthKey();
  usage[userKey] = { [m]: (usage[userKey] && usage[userKey][m] ? usage[userKey][m] : 0) + usd };
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (e) {
    console.warn('usage non enregistré', e.message);
  }
}

// --- limites : parallèle global et un travail à la fois par utilisateur ---
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

// --- outils de l'agent (résultats volontairement courts pour garder le coût bas) ---
const TOOLDEFS = [
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Cherche un mot ou une expression dans le code du dépôt. Renvoie fichier:ligne:texte (25 résultats maximum).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liste les fichiers dont le chemin contient un texte (40 maximum).',
      parameters: { type: 'object', properties: { contains: { type: 'string' } }, required: ['contains'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lit un fichier avec numéros de ligne. Par défaut les lignes 1 à 120. Précise start et end pour lire ailleurs.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Remplace un texte EXACT qui apparaît une seule fois dans un fichier. Garde le texte à remplacer court mais unique.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Termine la tâche. Donne un résumé de 2 phrases : la cause et ce qui a été changé (ou ce qui manque).',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
];

const SYSTEM =
  'Tu es un développeur expert qui corrige un bug dans un dépôt Git. Méthode : cherche avec search_code ou list_files, lis seulement ce qui est utile avec read_file, corrige avec edit_file en changeant le minimum de lignes, puis appelle finish avec un résumé de 2 phrases. Ne relis pas un fichier déjà lu. Si tu ne peux pas corriger, appelle finish et explique ce qui manque. Tu as au maximum ' +
  MAX_STEPS +
  ' étapes.';

function safePath(dir, p) {
  const full = path.resolve(dir, String(p || ''));
  const rel = path.relative(dir, full);
  if (!rel || rel.startsWith('..') || rel.startsWith('.git') || path.isAbsolute(rel)) return null;
  return full;
}

async function execTool(name, args, dir, changed) {
  try {
    if (name === 'search_code') {
      const q = String(args.query || '').slice(0, 120);
      if (!q) return 'Recherche vide.';
      try {
        const { stdout } = await git(['grep', '-n', '-i', '-I', '-F', '-e', q, '--', '.', ':(exclude)*lock*', ':(exclude)*.min.*'], dir);
        const lines = stdout.split('\n').filter(Boolean);
        return lines.slice(0, 25).map((l) => l.slice(0, 200)).join('\n') + (lines.length > 25 ? `\n... ${lines.length - 25} autres résultats` : '');
      } catch (e) {
        return 'Aucun résultat.';
      }
    }
    if (name === 'list_files') {
      const c = String(args.contains || '').toLowerCase();
      const { stdout } = await git(['ls-files'], dir);
      const files = stdout.split('\n').filter((f) => f && f.toLowerCase().includes(c));
      return files.slice(0, 40).join('\n') || 'Aucun fichier.';
    }
    if (name === 'read_file') {
      const full = safePath(dir, args.path);
      if (!full || !fs.existsSync(full)) return 'Fichier introuvable.';
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      const start = Math.max(1, parseInt(args.start || 1, 10));
      const end = Math.min(lines.length, parseInt(args.end || start + 119, 10), start + 199);
      const out = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n').slice(0, 6000);
      return `${args.path} (${lines.length} lignes, affichage ${start}-${end})\n${out}`;
    }
    if (name === 'edit_file') {
      const full = safePath(dir, args.path);
      if (!full || !fs.existsSync(full)) return 'Fichier introuvable.';
      const content = fs.readFileSync(full, 'utf8');
      const search = String(args.search || '');
      const count = search ? content.split(search).length - 1 : 0;
      if (count !== 1) return `Échec : le texte à remplacer doit apparaître exactement une fois (trouvé ${count} fois).`;
      fs.writeFileSync(full, content.replace(search, () => String(args.replace ?? '')));
      changed.add(String(args.path));
      return 'Modification appliquée.';
    }
    return 'Outil inconnu.';
  } catch (e) {
    return 'Erreur : ' + String(e.message || e).slice(0, 150);
  }
}

async function chat(messages) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DS_KEY },
    body: JSON.stringify({ model: DS_MODEL, temperature: 0, max_tokens: 1500, tools: TOOLDEFS, tool_choice: 'auto', messages }),
  });
  const j = await r.json();
  if (!j.choices) throw new Error('Réponse du modèle invalide : ' + JSON.stringify(j).slice(0, 150));
  const tokensIn = (j.usage && j.usage.prompt_tokens) || 4000;
  const tokensOut = (j.usage && j.usage.completion_tokens) || 300;
  return { msg: j.choices[0].message, usd: (tokensIn * PRICE_IN + tokensOut * PRICE_OUT) / 1e6 };
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
  if (spent(userKey) >= FIX_BUDGET) return `Budget de corrections épuisé pour ce mois (${spent(userKey).toFixed(2)} $ sur ${FIX_BUDGET.toFixed(2)} $). Il revient le mois prochain.`;
  if (busyUsers.has(userKey)) return 'Une de tes corrections est déjà en cours, attends qu\'elle finisse.';

  busyUsers.add(userKey);
  await acquire();
  try {
    cleanup();
    const dir = path.join(DATA, userKey, owner, repo);
    const base = await sync(dir, owner, repo, token);
    fs.utimesSync(dir, new Date(), new Date());

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Dépôt : ${owner}/${repo}\nProblème : ${problem}` },
    ];
    const changed = new Set();
    let summary = '';
    let steps = 0;
    let stopReason = '';

    for (; steps < MAX_STEPS; steps++) {
      if (spent(userKey) >= FIX_BUDGET) {
        stopReason = 'Budget du mois atteint, arrêt.';
        break;
      }
      const { msg, usd } = await chat(messages);
      addSpent(userKey, usd);
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        summary = msg.content || '';
        break;
      }
      let done = false;
      for (const call of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch (e) {
          args = {};
        }
        let result;
        if (call.function.name === 'finish') {
          summary = String(args.summary || '');
          result = 'Terminé.';
          done = true;
        } else {
          result = await execTool(call.function.name, args, dir, changed);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (done) break;
    }
    if (!summary && !stopReason && steps >= MAX_STEPS) stopReason = `Limite de ${MAX_STEPS} étapes atteinte.`;

    const left = `Étapes : ${Math.min(steps + 1, MAX_STEPS)} | Budget corrections restant ce mois : ${Math.max(0, FIX_BUDGET - spent(userKey)).toFixed(2)} $`;
    const note = [summary, stopReason].filter(Boolean).join('\n');
    if (changed.size === 0) return `${note || 'Aucune modification.'}\nAucun fichier modifié.\n${left}`;

    const branch = 'devfix/' + Date.now();
    await git(['checkout', '-b', branch], dir);
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=dev-fix', '-c', 'user.email=dev-fix@users.noreply.github.com', 'commit', '-m', 'dev-fix: ' + problem.slice(0, 60)], dir);
    await git(['push', 'origin', branch], dir, token);
    const pr = await gh(token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: 'dev-fix: ' + problem.slice(0, 60), head: branch, base, body: note }),
    });
    return `${note}\nFichiers modifiés : ${[...changed].join(', ')}\nPull request : ${pr.html_url || scrub(JSON.stringify(pr).slice(0, 200), token)}\n${left}`;
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
      'Agent développeur : corrige un bug dans un de TES dépôts GitHub. Il cherche, lit, modifie le code en plusieurs étapes, puis ouvre une pull request. Entrée : repo (nom du dépôt, ou proprietaire/nom), problem (le problème en une ou deux phrases). Peut durer plusieurs minutes.',
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
        serverInfo: { name: 'dev-fix', version: '3.0.0' },
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
