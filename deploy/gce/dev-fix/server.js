const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

// Agent de développement, un par utilisateur : son token GitHub, ses dépôts, son espace de travail,
// son budget de tokens par mois, et son PROPRE conteneur isolé pour le build et les tests.
// Le conteneur démarre quand l'agent en a besoin et s'éteint dès que la tâche est finie.
// Le clonage, le build, les tests et git se font en local : aucun token consommé.
// L'IA ne reçoit que les lignes d'erreur utiles.
const SECRET = process.env.MCP_SECRET || '';
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_PARALLEL = parseInt(process.env.MAX_PARALLEL || '3', 10);
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '15', 10);
const FIX_BUDGET = parseFloat(process.env.FIX_BUDGET_USD || '1');
const PRICE_IN = parseFloat(process.env.DS_PRICE_IN || '0.14'); // dollars par million de tokens d'entrée
const PRICE_OUT = parseFloat(process.env.DS_PRICE_OUT || '0.28'); // dollars par million de tokens de sortie
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'node:20-bookworm-slim';
const SANDBOX_NETWORK = process.env.SANDBOX_NETWORK || 'bridge';
const SANDBOX_MEMORY = process.env.SANDBOX_MEMORY || '1g';
const CMD_TIMEOUT_MS = parseInt(process.env.CMD_TIMEOUT_SEC || '180', 10) * 1000;
const HOST_DATA = process.env.HOST_DATA || ''; // chemin du dossier /data vu depuis la machine (pour Docker)
const DATA = '/data/repos';
const GITDIRS = '/data/gitdirs'; // dossiers .git hors de portée des conteneurs
const USAGE_FILE = '/data/usage.json';

const b64 = (token) => Buffer.from('x-access-token:' + token).toString('base64');
const git = (args, cwd, token, gitdir) =>
  run('git', ['-c', 'core.hooksPath=/dev/null', ...(token ? ['-c', 'http.extraHeader=Authorization: Basic ' + b64(token)] : []), ...args], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: gitdir ? { ...process.env, GIT_DIR: gitdir, GIT_WORK_TREE: cwd } : process.env,
  });
const docker = (args, opts = {}) => run('docker', args, { maxBuffer: 10 * 1024 * 1024, ...opts });
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
          if (now - fs.statSync(d).mtimeMs > 3 * 864e5) {
            fs.rmSync(d, { recursive: true, force: true });
            fs.rmSync(path.join(GITDIRS, u, o, r + '.git'), { recursive: true, force: true });
          }
        }
  } catch (e) {
    /* rien à nettoyer */
  }
}

// Au démarrage : éteint les conteneurs oubliés (après un redémarrage du serveur par exemple).
(async () => {
  try {
    const { stdout } = await docker(['ps', '-aq', '--filter', 'label=devfix=1']);
    const ids = stdout.split('\n').filter(Boolean);
    if (ids.length) await docker(['rm', '-f', ...ids]);
  } catch (e) {
    /* Docker indisponible : ignoré */
  }
})();

async function sync(dir, gitdir, owner, repo, token) {
  if (!fs.existsSync(gitdir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(path.dirname(gitdir), { recursive: true });
    await git(['clone', '--depth', '50', '--separate-git-dir=' + gitdir, `https://github.com/${owner}/${repo}.git`, dir], undefined, token);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    await git(['fetch', 'origin', '--depth', '50'], dir, token, gitdir);
  }
  const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], dir, undefined, gitdir)).stdout.trim();
  const base = ref.replace('refs/remotes/origin/', '');
  await git(['checkout', '-f', '--detach', 'origin/' + base], dir, undefined, gitdir);
  await git(['clean', '-fd'], dir, undefined, gitdir);
  return base;
}

// --- conteneur isolé de la tâche ---
function summarize(code, output) {
  const lines = String(output || '').split('\n');
  if (code === 0) return 'Code de sortie : 0 (réussi)\n' + lines.filter(Boolean).slice(-5).join('\n').slice(0, 600);
  const re = /error|erreur|fail|✕|✗|exception|traceback|cannot find|not found|ERR!|assert/i;
  const keep = new Set();
  lines.forEach((l, i) => {
    if (re.test(l)) for (let k = Math.max(0, i - 1); k <= Math.min(lines.length - 1, i + 2); k++) keep.add(k);
  });
  let picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  if (picked.length === 0) picked = lines.filter(Boolean).slice(-8);
  return `Code de sortie : ${code}\n` + picked.slice(-40).join('\n').slice(0, 2500);
}

async function startSandbox(sb, dir) {
  if (!HOST_DATA) throw new Error('Bac à sable non configuré (HOST_DATA manquant).');
  const hostDir = path.join(HOST_DATA, 'repos', path.relative(DATA, dir));
  await run('chown', ['-R', '1000:1000', dir]);
  await docker([
    'run', '-d', '--rm',
    '--name', sb.name,
    '--label', 'devfix=1',
    '--memory', SANDBOX_MEMORY, '--memory-swap', SANDBOX_MEMORY,
    '--cpus', '1',
    '--pids-limit', '256',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--network', SANDBOX_NETWORK,
    '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,size=256m',
    '-e', 'HOME=/tmp',
    '-v', `${hostDir}:/work`,
    '-w', '/work',
    SANDBOX_IMAGE, 'sleep', '1800',
  ]);
  sb.started = true;
}

async function runCommand(sb, dir, command) {
  const cmd = String(command || '').slice(0, 500);
  if (!cmd) return 'Commande vide.';
  if (!sb.started) await startSandbox(sb, dir);
  try {
    const { stdout, stderr } = await docker(['exec', '-w', '/work', sb.name, 'sh', '-c', cmd], { timeout: CMD_TIMEOUT_MS });
    return summarize(0, stdout + '\n' + stderr);
  } catch (e) {
    if (e.killed) return `Commande interrompue après ${Math.round(CMD_TIMEOUT_MS / 1000)} secondes.`;
    return summarize(typeof e.code === 'number' ? e.code : 1, (e.stdout || '') + '\n' + (e.stderr || ''));
  }
}

async function stopSandbox(sb) {
  if (sb.started) await docker(['rm', '-f', sb.name]).catch(() => {});
  sb.started = false;
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
      name: 'run_command',
      description:
        'Lance une commande dans un conteneur isolé à la racine du dépôt (ex : npm ci, npm test, npm run build). Renvoie le code de sortie et seulement les lignes d\'erreur utiles. Pas de git dans le conteneur.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
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
  'Tu es un développeur expert qui corrige un bug dans un dépôt Git. Méthode : cherche avec search_code ou list_files, lis seulement ce qui est utile avec read_file, corrige avec edit_file en changeant le minimum de lignes. Pour vérifier, utilise run_command : installe les dépendances une seule fois (npm ci ou npm install), puis lance les tests ou le build ; tu ne reçois que les erreurs utiles. Si une commande échoue, corrige puis relance. Termine avec finish et un résumé de 2 phrases. Ne relis pas un fichier déjà lu. Si tu ne peux pas corriger, appelle finish et explique ce qui manque. Tu as au maximum ' +
  MAX_STEPS +
  ' étapes.';

// Chemin sûr : dans le dépôt, hors .git, et sans suivre un lien symbolique vers l'extérieur.
function safePath(dir, p) {
  const full = path.resolve(dir, String(p || ''));
  const rel = path.relative(dir, full);
  if (!rel || rel.startsWith('..') || rel.startsWith('.git') || path.isAbsolute(rel)) return null;
  try {
    const real = fs.realpathSync(full);
    const realDir = fs.realpathSync(dir);
    if (!real.startsWith(realDir + path.sep)) return null;
  } catch (e) {
    return null;
  }
  return full;
}

async function execTool(name, args, ctx) {
  const { dir, gitdir, changed, sb } = ctx;
  try {
    if (name === 'search_code') {
      const q = String(args.query || '').slice(0, 120);
      if (!q) return 'Recherche vide.';
      try {
        const { stdout } = await git(['grep', '-n', '-i', '-I', '-F', '-e', q, '--', '.', ':(exclude)*lock*', ':(exclude)*.min.*'], dir, undefined, gitdir);
        const lines = stdout.split('\n').filter(Boolean);
        return lines.slice(0, 25).map((l) => l.slice(0, 200)).join('\n') + (lines.length > 25 ? `\n... ${lines.length - 25} autres résultats` : '');
      } catch (e) {
        return 'Aucun résultat.';
      }
    }
    if (name === 'list_files') {
      const c = String(args.contains || '').toLowerCase();
      const { stdout } = await git(['ls-files'], dir, undefined, gitdir);
      const files = stdout.split('\n').filter((f) => f && f.toLowerCase().includes(c));
      return files.slice(0, 40).join('\n') || 'Aucun fichier.';
    }
    if (name === 'read_file') {
      const full = safePath(dir, args.path);
      if (!full) return 'Fichier introuvable.';
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      const start = Math.max(1, parseInt(args.start || 1, 10));
      const end = Math.min(lines.length, parseInt(args.end || start + 119, 10), start + 199);
      const out = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n').slice(0, 6000);
      return `${args.path} (${lines.length} lignes, affichage ${start}-${end})\n${out}`;
    }
    if (name === 'edit_file') {
      const full = safePath(dir, args.path);
      if (!full) return 'Fichier introuvable.';
      const content = fs.readFileSync(full, 'utf8');
      const search = String(args.search || '');
      const count = search ? content.split(search).length - 1 : 0;
      if (count !== 1) return `Échec : le texte à remplacer doit apparaître exactement une fois (trouvé ${count} fois).`;
      fs.writeFileSync(full, content.replace(search, () => String(args.replace ?? '')));
      changed.add(String(args.path));
      return 'Modification appliquée.';
    }
    if (name === 'run_command') {
      return await runCommand(sb, dir, args.command);
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
  const sb = { name: 'devfix-' + crypto.randomBytes(6).toString('hex'), started: false };
  try {
    cleanup();
    const dir = path.join(DATA, userKey, owner, repo);
    const gitdir = path.join(GITDIRS, userKey, owner, repo + '.git');
    const base = await sync(dir, gitdir, owner, repo, token);
    fs.utimesSync(dir, new Date(), new Date());

    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Dépôt : ${owner}/${repo}\nProblème : ${problem}` },
    ];
    const changed = new Set();
    const tctx = { dir, gitdir, changed, sb };
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
          result = await execTool(call.function.name, args, tctx);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      if (done) break;
    }
    if (!summary && !stopReason && steps >= MAX_STEPS) stopReason = `Limite de ${MAX_STEPS} étapes atteinte.`;
    await stopSandbox(sb); // le conteneur s'éteint dès que le travail est fini

    const left = `Étapes : ${Math.min(steps + 1, MAX_STEPS)} | Budget corrections restant ce mois : ${Math.max(0, FIX_BUDGET - spent(userKey)).toFixed(2)} $`;
    const note = [summary, stopReason].filter(Boolean).join('\n');
    if (changed.size === 0) return `${note || 'Aucune modification.'}\nAucun fichier modifié.\n${left}`;

    const branch = 'devfix/' + Date.now();
    await git(['checkout', '-b', branch], dir, undefined, gitdir);
    await git(['add', '-A', '--', '.', ':(exclude)node_modules'], dir, undefined, gitdir);
    await git(['-c', 'user.name=dev-fix', '-c', 'user.email=dev-fix@users.noreply.github.com', 'commit', '-m', 'dev-fix: ' + problem.slice(0, 60)], dir, undefined, gitdir);
    await git(['push', 'origin', branch], dir, token, gitdir);
    const pr = await gh(token, `/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: 'dev-fix: ' + problem.slice(0, 60), head: branch, base, body: note }),
    });
    return `${note}\nFichiers modifiés : ${[...changed].join(', ')}\nPull request : ${pr.html_url || scrub(JSON.stringify(pr).slice(0, 200), token)}\n${left}`;
  } catch (e) {
    return 'Erreur : ' + scrub(String(e.stderr || e.message || e).slice(0, 300), token);
  } finally {
    await stopSandbox(sb);
    busyUsers.delete(userKey);
    release();
  }
}

const TOOLS = [
  {
    name: 'dev_fix',
    description:
      'Agent développeur : corrige un bug dans un de TES dépôts GitHub. Il cherche, lit, modifie le code, lance les tests dans un conteneur isolé, recommence si besoin, puis ouvre une pull request. Entrée : repo (nom du dépôt, ou proprietaire/nom), problem (le problème en une ou deux phrases). Peut durer plusieurs minutes.',
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
        serverInfo: { name: 'dev-fix', version: '4.0.0' },
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
