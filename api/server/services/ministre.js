/**
 * Le Ministre, version intégrée à LibreChat.
 *
 * Au lieu de donner à l'agent la définition de toutes les fonctions de tous les serveurs MCP
 * (des dizaines d'outils = des milliers de tokens à chaque message), on ne lui en montre que 3 :
 *   - chercher_outil : trouve les 5 meilleurs outils pour une demande ;
 *   - appeler_outil  : exécute l'un d'eux, avec l'identité et les droits de L'UTILISATEUR,
 *                      puis renvoie un résultat nettoyé et court ;
 *   - verifier       : état de la CI GitHub Actions d'un dépôt.
 *
 * Comme le Ministre vit DANS LibreChat, il couvre tous les serveurs MCP de l'agent : ceux de
 * librechat.yaml ET ceux que les utilisateurs ajoutent eux-mêmes. L'authentification (OAuth,
 * jetons personnels, en-têtes) reste gérée par le gestionnaire MCP de LibreChat : rien à refaire.
 *
 * ACTIF SEULEMENT si la variable d'environnement MINISTRE_MODE=on. Sinon ce fichier ne fait rien.
 * Toute erreur dans le Ministre est rattrapée côté appelant : LibreChat retombe sur son
 * comportement normal.
 *
 * Réglages optionnels : MAX_CHARS (4000), MAX_ITEMS (15), MAX_STR (600), MINISTRE_TOP (5).
 */
'use strict';

const MCP_DELIMITER = '_mcp_';
const MCP_SERVER_PIN = `sys__server__sys${MCP_DELIMITER}`;

const NAMES = Object.freeze({
  search: 'chercher_outil',
  call: 'appeler_outil',
  verify: 'verifier',
});
const META_NAMES = Object.freeze([NAMES.search, NAMES.call, NAMES.verify]);

const isOn = () => String(process.env.MINISTRE_MODE || '').toLowerCase() === 'on';
const isMinistreName = (name) => META_NAMES.includes(name);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const limits = () => ({
  maxChars: num(process.env.MAX_CHARS, 4000),
  maxItems: num(process.env.MAX_ITEMS, 15),
  maxStr: num(process.env.MAX_STR, 600),
  top: num(process.env.MINISTRE_TOP, 5),
});

/* ------------------------------------------------------------------ définitions vues par l'agent */

/** Un outil MCP « réel » (pas une épingle de serveur, pas une action OpenAPI). */
function isMcpDefinition(def) {
  const name = def && def.name;
  return (
    typeof name === 'string' &&
    name.includes(MCP_DELIMITER) &&
    !name.startsWith(MCP_SERVER_PIN) &&
    !name.includes('_action_')
  );
}

function serverOfKey(key) {
  const i = String(key).lastIndexOf(MCP_DELIMITER);
  return i === -1 ? '' : String(key).slice(i + MCP_DELIMITER.length);
}

function metaDefinitions(serverNames) {
  const servers = serverNames.length ? ` Serveurs disponibles : ${serverNames.join(', ')}.` : '';
  return [
    {
      name: NAMES.search,
      description:
        `Trouve l'outil qu'il te faut parmi ceux des serveurs connectés.${servers} ` +
        `Renvoie les meilleurs outils avec leurs paramètres. Appelle-le AVANT appeler_outil.`,
      parameters: {
        type: 'object',
        properties: {
          requete: { type: 'string', description: 'Ce que tu veux faire, en quelques mots' },
          serveur: { type: 'string', description: 'Optionnel : limiter à un serveur' },
        },
        required: ['requete'],
      },
    },
    {
      name: NAMES.call,
      description:
        "Exécute un outil trouvé avec chercher_outil, avec les droits de l'utilisateur. " +
        'Le résultat est nettoyé et raccourci.',
      parameters: {
        type: 'object',
        properties: {
          outil: { type: 'string', description: "Nom exact de l'outil, tel que renvoyé par chercher_outil" },
          arguments: { type: 'object', description: "Paramètres de l'outil" },
        },
        required: ['outil'],
      },
    },
    {
      name: NAMES.verify,
      description: "État de la CI GitHub Actions d'un dépôt : OK, EN COURS ou ÉCHEC avec l'erreur exacte.",
      parameters: {
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

/**
 * Remplace, dans le résultat de loadToolDefinitionsWrapper, toutes les définitions d'outils MCP
 * par les 3 définitions du Ministre. Sans outil MCP, le résultat est rendu tel quel.
 * @param {{ toolDefinitions?: Array, toolRegistry?: Map }} input
 */
function reduceDefinitions({ toolDefinitions, toolRegistry }) {
  if (!Array.isArray(toolDefinitions)) {
    return { toolDefinitions, toolRegistry };
  }
  const mcp = toolDefinitions.filter(isMcpDefinition);
  if (mcp.length === 0) {
    return { toolDefinitions, toolRegistry };
  }
  const servers = [...new Set(mcp.map((d) => serverOfKey(d.name)).filter(Boolean))];
  const meta = metaDefinitions(servers);
  const kept = toolDefinitions.filter((d) => !isMcpDefinition(d));

  let registry = toolRegistry;
  if (toolRegistry instanceof Map) {
    registry = new Map(toolRegistry);
    for (const d of mcp) {
      registry.delete(d.name);
    }
    for (const d of meta) {
      registry.set(d.name, d);
    }
  }
  return { toolDefinitions: [...kept, ...meta], toolRegistry: registry };
}

/* ------------------------------------------------------------------ catalogue (par utilisateur / agent) */

/**
 * Liste des outils que CET agent a le droit d'utiliser, d'après les serveurs MCP connectés
 * (mcpAvailableTools = { serveur: { cléOutil: { function: {name, description, parameters} } } })
 * et la sélection de l'agent (agentTools) : un serveur « épinglé » donne tous ses outils,
 * sinon seuls les outils explicitement cochés.
 */
function buildCatalog(mcpAvailableTools, agentTools) {
  const selected = Array.isArray(agentTools) ? agentTools : [];
  const entries = [];
  for (const [server, tools] of Object.entries(mcpAvailableTools || {})) {
    if (!tools || typeof tools !== 'object') {
      continue;
    }
    const pinned = selected.some((t) => typeof t === 'string' && t === `${MCP_SERVER_PIN}${server}`);
    for (const [key, def] of Object.entries(tools)) {
      if (!pinned && !selected.includes(key)) {
        continue;
      }
      const fn = (def && def.function) || {};
      entries.push({
        key,
        server,
        description: String(fn.description || ''),
        parameters: fn.parameters || {},
      });
    }
  }
  return entries;
}

function shortParams(schema) {
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  return Object.entries(props)
    .map(([k, v]) => {
      const type = Array.isArray(v && v.type) ? v.type.join('|') : (v && v.type) || 'any';
      return `${k}${required.has(k) ? '*' : ''}:${type}`;
    })
    .join(', ');
}

function score(entry, words) {
  const name = entry.key.toLowerCase();
  const hay = `${name} ${entry.description.toLowerCase()}`;
  let s = 0;
  for (const w of words) {
    if (name.includes(w)) {
      s += 3;
    } else if (hay.includes(w)) {
      s += 1;
    }
  }
  return s;
}

function searchCatalog(catalog, { requete, serveur }) {
  if (catalog.length === 0) {
    return "Aucun outil MCP n'est disponible pour cet agent (serveur non connecté ou non sélectionné).";
  }
  const pool = serveur ? catalog.filter((e) => e.server === serveur) : catalog;
  if (serveur && pool.length === 0) {
    const servers = [...new Set(catalog.map((e) => e.server))].join(', ');
    return `Serveur inconnu « ${serveur} ». Disponibles : ${servers}`;
  }
  const words = String(requete || '')
    .toLowerCase()
    .split(/[^a-z0-9àâçéèêëîïôûùüÿ_]+/i)
    .filter((w) => w.length > 2);
  const top = pool
    .map((entry) => ({ entry, s: score(entry, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limits().top)
    .map(({ entry }) => {
      const d = entry.description.replace(/\s+/g, ' ').slice(0, 100);
      return `${entry.key}(${shortParams(entry.parameters)}) — ${d}`;
    });
  const lines = top.length
    ? top
    : [`Aucun outil trouvé pour « ${requete} ». Reformule avec d'autres mots ou précise le serveur.`];
  lines.push('(* = paramètre obligatoire. Appelle ensuite appeler_outil avec le nom exact.)');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ nettoyage des résultats */

const DROP = /^(url|node_id|gravatar_id|_links|etag|user_view_type|site_admin|permissions)$|_url$/i;
const KEEP = new Set(['html_url']);

function decodeBase64Utf8(b64) {
  return Buffer.from(String(b64).replace(/\s/g, ''), 'base64').toString('utf8');
}

/** Supprime le bruit (URLs d'API, ids internes, valeurs vides) et tronque listes et textes. */
function clean(value, { maxItems, maxStr }) {
  const walk = (v, depth) => {
    if (v === null || v === undefined || v === '') {
      return undefined;
    }
    if (typeof v === 'string') {
      return v.length > maxStr ? `${v.slice(0, maxStr)}…[+${v.length - maxStr} car.]` : v;
    }
    if (Array.isArray(v)) {
      const items = v
        .slice(0, maxItems)
        .map((x) => walk(x, depth + 1))
        .filter((x) => x !== undefined);
      if (v.length > maxItems) {
        items.push(`…+${v.length - maxItems} autres`);
      }
      return items.length ? items : undefined;
    }
    if (typeof v === 'object') {
      if (depth > 6) {
        return undefined;
      }
      let obj = v;
      if (obj.encoding === 'base64' && typeof obj.content === 'string') {
        try {
          obj = { ...obj, content: decodeBase64Utf8(obj.content), encoding: undefined };
        } catch (_e) {
          /* on garde tel quel */
        }
      }
      const out = {};
      for (const [k, x] of Object.entries(obj)) {
        if (DROP.test(k) && !KEEP.has(k)) {
          continue;
        }
        const c = walk(x, depth + 1);
        if (c !== undefined) {
          out[k] = c;
        }
      }
      return Object.keys(out).length ? out : undefined;
    }
    return v;
  };
  return walk(value, 0);
}

/** Met en texte court le retour d'un outil LibreChat (chaîne, blocs de contenu, ou [contenu, artefact]). */
function formatResult(raw, opts = limits()) {
  let content = raw;
  if (content && !Array.isArray(content) && typeof content === 'object' && 'content' in content) {
    content = content.content; // ToolMessage
  }
  if (Array.isArray(content) && content.length === 2 && !('type' in Object(content[0]))) {
    content = content[0]; // [contenu, artefact]
  }

  const blocks = Array.isArray(content) ? content : [content];
  const parts = [];
  for (const b of blocks) {
    if (b === null || b === undefined) {
      continue;
    }
    if (typeof b === 'string') {
      parts.push(b);
    } else if (b.type === 'text') {
      parts.push(String(b.text || ''));
    } else if (b.type === 'image_url' || b.type === 'image') {
      parts.push('[image omise]');
    } else if (b.type) {
      parts.push(`[${b.type} omis]`);
    } else {
      parts.push(JSON.stringify(b));
    }
  }

  const text = parts
    .map((t) => {
      try {
        const cleaned = clean(JSON.parse(t), opts);
        return cleaned === undefined ? '(vide)' : JSON.stringify(cleaned);
      } catch (_e) {
        return t;
      }
    })
    .join('\n');

  let out = text || '(résultat vide)';
  if (out.length > opts.maxChars) {
    const extra = out.length - opts.maxChars;
    out = `${out.slice(0, opts.maxChars)}\n…[tronqué : ${extra} caractères de plus, affine ta demande]`;
  }
  return out;
}

/* ------------------------------------------------------------------ verifier (CI GitHub Actions) */

const GH_API = 'https://api.github.com';
const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Jeton GitHub PERSONNEL de l'utilisateur (coffre githubLink), sinon GITHUB_TOKEN du serveur. */
async function githubToken(userId) {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (secret && USER_RE.test(userId || '')) {
    try {
      const r = await fetch(
        `http://127.0.0.1:${process.env.PORT || 3080}/api/github-link/token?user=${encodeURIComponent(userId)}`,
        { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) },
      );
      if (r.ok) {
        const data = await r.json();
        if (data && data.token) {
          return data.token;
        }
      }
    } catch (_e) {
      /* repli ci-dessous */
    }
  }
  return process.env.GITHUB_TOKEN || '';
}

function tailLog(text, lines = 25) {
  const cleaned = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ''))
    .filter((l) => l.trim());
  return cleaned.slice(-lines).join('\n').slice(-1500);
}

async function verifyCi({ repo, branche }, userId) {
  const token = await githubToken(userId);
  if (!token) {
    return "ERREUR : GitHub n'est pas connecté pour cet utilisateur (et GITHUB_TOKEN n'est pas défini).";
  }
  if (!repo || !String(repo).includes('/')) {
    return 'ERREUR : paramètre repo attendu au format proprietaire/nom.';
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ministre-librechat',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const q = new URLSearchParams({ per_page: '1' });
  if (branche) {
    q.set('branch', branche);
  }
  const r = await fetch(`${GH_API}/repos/${repo}/actions/runs?${q}`, { headers });
  if (!r.ok) {
    return `ERREUR GitHub ${r.status} sur ${repo}`;
  }
  const run = ((await r.json()).workflow_runs || [])[0];
  if (!run) {
    return 'Aucune exécution CI trouvée pour cette branche.';
  }
  const head = `${run.name} · ${run.head_branch} · ${String(run.head_sha).slice(0, 7)}`;
  if (run.status !== 'completed') {
    return `EN COURS (${run.status}) — ${head}. Rappelle verifier dans ~30 s.`;
  }
  if (run.conclusion === 'success') {
    return `OK — ${head}`;
  }
  const jr = await fetch(`${GH_API}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`, { headers });
  const jobs = jr.ok ? (await jr.json()).jobs || [] : [];
  const failed = jobs.filter((j) => j.conclusion === 'failure');
  const lines = failed.slice(0, 5).map((j) => {
    const step = (j.steps || []).find((s) => s.conclusion === 'failure');
    return `${j.name} → étape « ${step ? step.name : '?'} »`;
  });
  let log = '';
  if (failed[0]) {
    const lr = await fetch(`${GH_API}/repos/${repo}/actions/jobs/${failed[0].id}/logs`, { headers }).catch(
      () => null,
    );
    if (lr && lr.ok) {
      log = tailLog(await lr.text());
    }
  }
  return [
    `ÉCHEC (${run.conclusion}) — ${head}`,
    ...lines,
    log ? `--- fin du journal ---\n${log}` : '',
    run.html_url,
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ les 3 outils à l'exécution */

/**
 * @param {Object} params
 * @param {Function} params.toolFn - `tool` de @librechat/agents/langchain/tools
 * @param {Record<string, Record<string, any>>} params.mcpAvailableTools - outils MCP de la requête
 * @param {string[]} params.agentTools - agent.tools (sélection de l'agent)
 * @param {string} params.userId
 * @param {(key: string, args: Object) => Promise<any>} params.runTool - exécute VRAIMENT l'outil MCP
 *   (avec les droits et jetons de l'utilisateur) : fourni par ToolService.
 * @param {{ warn?: Function, debug?: Function }} [params.logger]
 */
function createMinistreTools({ toolFn, mcpAvailableTools, agentTools, userId, runTool, logger }) {
  const catalog = buildCatalog(mcpAvailableTools, agentTools);
  const byKey = new Map(catalog.map((e) => [e.key, e]));
  const defs = Object.fromEntries(
    metaDefinitions([...new Set(catalog.map((e) => e.server))]).map((d) => [d.name, d]),
  );
  const safe = (e) => String((e && e.message) || e).slice(0, 300);

  const handlers = {
    [NAMES.search]: async (args) => searchCatalog(catalog, args || {}),
    [NAMES.call]: async (args) => {
      const key = String((args && args.outil) || '');
      if (!byKey.has(key)) {
        return `ERREUR : outil inconnu « ${key} ». Utilise chercher_outil pour obtenir le nom exact.`;
      }
      try {
        return formatResult(await runTool(key, (args && args.arguments) || {}));
      } catch (e) {
        if (logger && logger.warn) {
          logger.warn(`[Ministre] appel de ${key} en échec : ${safe(e)}`);
        }
        return `ERREUR : ${safe(e)}`;
      }
    },
    [NAMES.verify]: async (args) => {
      try {
        return await verifyCi(args || {}, userId);
      } catch (e) {
        return `ERREUR : ${safe(e)}`;
      }
    },
  };

  return META_NAMES.map((name) =>
    toolFn(async (args) => handlers[name](args), {
      name,
      description: defs[name].description,
      schema: defs[name].parameters,
    }),
  );
}

module.exports = {
  NAMES,
  META_NAMES,
  isOn,
  isMinistreName,
  isMcpDefinition,
  reduceDefinitions,
  buildCatalog,
  searchCatalog,
  formatResult,
  clean,
  createMinistreTools,
};
