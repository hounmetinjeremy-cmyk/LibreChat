// Le Ministre : proxy MCP universel.
// L'agent ne voit que 3 outils : chercher_outil, appeler_outil, verifier.
// Les serveurs MCP restent intacts derrière le Ministre (config UPSTREAMS).
// Chaque appel est fait avec le jeton PERSONNEL de l'utilisateur (voir auth.js).

import { listTools, callTool } from './upstream.js';
import { formatResult } from './clean.js';
import { verifier } from './ci.js';
import { userAuth, connectLink } from './auth.js';

const cache = new Map(); // nom de serveur -> { at, tools } (liste d'outils, sans données personnelles)

function upstreams(env) {
  try {
    return JSON.parse(env.UPSTREAMS || '{}');
  } catch {
    return {};
  }
}

function opts(env) {
  return {
    maxChars: Number(env.MAX_CHARS || 4000),
    maxItems: Number(env.MAX_ITEMS || 15),
    maxStr: Number(env.MAX_STR || 600),
  };
}

function visibleError(message) {
  const err = new Error(message);
  err.visible = true; // message à transmettre tel quel à l'agent (ex. lien de connexion)
  return err;
}

// Prépare le serveur cible pour CET utilisateur (jeton personnel si le serveur est en mode « coffre »).
async function resolveUpstream(env, name, userId) {
  const up = upstreams(env)[name];
  if (!up) throw new Error(`serveur inconnu : ${name}`);
  const a = await userAuth(env, up, userId);
  if (a.notConnected) {
    const link = connectLink(env, up, userId);
    throw visibleError(
      link
        ? `${name} n'est pas connecté pour cet utilisateur. Montre-lui ce lien (valable 15 min) et demande-lui de redemander après la connexion :\n${link}`
        : `${name} n'est pas connecté pour cet utilisateur (lien de connexion indisponible : DOMAIN_SERVER ou ORCHESTRATOR_SECRET manquant).`,
    );
  }
  if (a.error) throw visibleError(`${name} : ${a.error}`);
  return { ...up, headers: { ...(up.headers || {}), ...a.headers } };
}

async function serverTools(env, name, userId) {
  const ttl = Number(env.CATALOG_TTL || 600) * 1000;
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < ttl) return hit.tools;
  const up = await resolveUpstream(env, name, userId);
  const tools = await listTools(up);
  cache.set(name, { at: Date.now(), tools });
  return tools;
}

function shortParams(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  return Object.entries(props)
    .map(([k, v]) => {
      const type = Array.isArray(v.type) ? v.type.join('|') : v.type || 'any';
      return `${k}${req.has(k) ? '*' : ''}:${type}`;
    })
    .join(', ');
}

function score(tool, words) {
  const name = tool.name.toLowerCase();
  const hay = `${name} ${(tool.description || '').toLowerCase()}`;
  let s = 0;
  for (const w of words) {
    if (name.includes(w)) s += 3;
    else if (hay.includes(w)) s += 1;
  }
  return s;
}

async function chercherOutil(env, { requete, serveur }, userId) {
  const ups = upstreams(env);
  const names = serveur ? [serveur] : Object.keys(ups);
  if (serveur && !ups[serveur]) return `Serveur inconnu. Disponibles : ${Object.keys(ups).join(', ')}`;
  const words = String(requete || '')
    .toLowerCase()
    .split(/[^a-z0-9àâçéèêëîïôûùüÿ_]+/i)
    .filter((w) => w.length > 2);

  const settled = await Promise.allSettled(names.map((n) => serverTools(env, n, userId)));
  const found = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'rejected') {
      const m = String((r.reason && r.reason.message) || r.reason);
      errors.push(r.reason && r.reason.visible ? m : `${names[i]} (${m.slice(0, 80)})`);
      return;
    }
    for (const t of r.value) found.push({ srv: names[i], tool: t, s: score(t, words) });
  });

  const top = found
    .filter((f) => f.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((f) => {
      const d = (f.tool.description || '').replace(/\s+/g, ' ').slice(0, 100);
      return `${f.srv}.${f.tool.name}(${shortParams(f.tool.inputSchema)}) — ${d}`;
    });

  const lines = top.length
    ? top
    : [`Aucun outil trouvé pour « ${requete} ». Reformule avec d'autres mots ou précise le serveur.`];
  if (errors.length) lines.push(`Indisponibles :\n${errors.join('\n')}`);
  lines.push('(* = paramètre obligatoire. Appelle avec appeler_outil.)');
  return lines.join('\n');
}

async function appelerOutil(env, { outil, arguments: args }, userId) {
  const dot = String(outil || '').indexOf('.');
  if (dot < 1) return 'ERREUR : outil attendu au format serveur.nom_outil (voir chercher_outil).';
  const srv = outil.slice(0, dot);
  const name = outil.slice(dot + 1);
  if (!upstreams(env)[srv]) {
    return `ERREUR : serveur inconnu « ${srv} ». Disponibles : ${Object.keys(upstreams(env)).join(', ')}`;
  }
  try {
    const up = await resolveUpstream(env, srv, userId);
    return formatResult(await callTool(up, name, args), opts(env));
  } catch (e) {
    return e && e.visible ? e.message : `ERREUR : ${String((e && e.message) || e).slice(0, 300)}`;
  }
}

async function verifierCi(env, args, userId) {
  let token = env.GITHUB_TOKEN;
  const gh = upstreams(env).github;
  if (gh && gh.auth && gh.auth.type === 'vault') {
    try {
      const up = await resolveUpstream(env, 'github', userId);
      token = String(up.headers.Authorization || '').replace(/^\S+\s+/, '');
    } catch (e) {
      return e && e.visible ? e.message : `ERREUR : ${String((e && e.message) || e).slice(0, 200)}`;
    }
  }
  return verifier({ ...env, GITHUB_TOKEN: token }, args || {});
}

function toolDefs(env) {
  const about = Object.entries(upstreams(env))
    .map(([n, u]) => `${n} (${u.about || '…'})`)
    .join(' ; ');
  return [
    {
      name: 'chercher_outil',
      description: `Trouve l'outil qu'il te faut. Serveurs : ${about}. Renvoie les 5 meilleurs outils avec leurs paramètres.`,
      inputSchema: {
        type: 'object',
        properties: {
          requete: { type: 'string', description: 'Ce que tu veux faire, en quelques mots' },
          serveur: { type: 'string', description: 'Optionnel : limiter à un serveur' },
        },
        required: ['requete'],
      },
    },
    {
      name: 'appeler_outil',
      description: 'Exécute un outil trouvé avec chercher_outil. Résultat nettoyé et court.',
      inputSchema: {
        type: 'object',
        properties: {
          outil: { type: 'string', description: 'serveur.nom_outil' },
          arguments: { type: 'object', description: "Paramètres de l'outil" },
        },
        required: ['outil'],
      },
    },
    {
      name: 'verifier',
      description: "État de la CI GitHub Actions d'un dépôt : OK, EN COURS ou ÉCHEC avec l'erreur exacte.",
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'proprietaire/nom' },
          branche: { type: 'string', description: 'Optionnel' },
        },
        required: ['repo'],
      },
    },
  ];
}

async function callMinistre(env, name, args, userId) {
  if (name === 'chercher_outil') return chercherOutil(env, args || {}, userId);
  if (name === 'appeler_outil') return appelerOutil(env, args || {}, userId);
  if (name === 'verifier') return verifierCi(env, args, userId);
  return `ERREUR : outil inconnu « ${name} ».`;
}

const reply = (id, result) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'Content-Type': 'application/json' },
  });

const fail = (id, code, message) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { 'Content-Type': 'application/json' },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ministre ok');
    if (req.method !== 'POST') return new Response(null, { status: 405 });

    const auth = req.headers.get('Authorization') || '';
    if (!env.MINISTRE_SECRET || auth !== `Bearer ${env.MINISTRE_SECRET}`) {
      return new Response('unauthorized', { status: 401 });
    }
    // Identifiant de l'utilisateur, posé par LibreChat côté serveur (jamais par l'utilisateur).
    const userId = req.headers.get('X-User-Id') || '';

    let msg;
    try {
      msg = await req.json();
    } catch {
      return fail(null, -32700, 'JSON invalide');
    }
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notification

    switch (msg.method) {
      case 'initialize':
        return reply(msg.id, {
          protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'ministre', version: '0.2.0' },
        });
      case 'ping':
        return reply(msg.id, {});
      case 'tools/list':
        return reply(msg.id, { tools: toolDefs(env) });
      case 'tools/call': {
        const text = await callMinistre(
          env,
          msg.params && msg.params.name,
          msg.params && msg.params.arguments,
          userId,
        );
        return reply(msg.id, { content: [{ type: 'text', text }] });
      }
      default:
        return fail(msg.id, -32601, `méthode inconnue : ${msg.method}`);
    }
  },
};
