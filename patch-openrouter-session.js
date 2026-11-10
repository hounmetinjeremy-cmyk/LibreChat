/**
 * Cache de prompt OpenRouter : envoie un session_id STABLE par conversation (champ « session_id » de la requête,
 * documenté par OpenRouter, 256 caractères au plus). Identifiant = utilisateur + premier message de la
 * conversation, donc identique à chaque étape d'une même conversation et différent d'une conversation à l'autre.
 * Note : OpenRouter n'applique pas le routage collant quand un ordre de fournisseurs est imposé (provider.order),
 * ce qui est le cas ici (Relace seul, sans repli). Le session_id sert alors surtout à regrouper les requêtes
 * d'une conversation dans la page Logs > Sessions d'OpenRouter ; le cache lui-même repose sur un début de prompt
 * identique d'une requête à l'autre chez Relace.
 * Jamais bloquant : si une ancre est introuvable, aiModels.js reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'patch-openrouter-session.js';
const RUN_LINE = "const run = (fn) => (typeof runAsSystem === 'function' ? runAsSystem(fn) : fn());";
const STREAM_COMMENT = "      // Compteur de tokens : le fournisseur envoie l'usage à la fin du flux (sauf Cloudflare).\n";

const helper = [
  '',
  '/** Identifiant de session stable par conversation (cache de prompt OpenRouter, patch-openrouter-session.js). */',
  'function cacheSessionId(req, body) {',
  '  try {',
  "    const first = (Array.isArray(body.messages) ? body.messages : []).find((m) => m && m.role !== 'system');",
  "    const text = typeof (first && first.content) === 'string' ? first.content : JSON.stringify((first && first.content) || '');",
  "    const user = String((req.headers && req.headers['x-user-id']) || 'anon');",
  "    return 'jeremy-' + crypto.createHash('sha256').update(user + '\\n' + text.slice(0, 2000)).digest('hex').slice(0, 40);",
  '  } catch (e) {',
  '    return undefined;',
  '  }',
  '}',
  '',
].join('\n');

const usage = [
  "      // Cache de prompt OpenRouter : session_id stable par conversation (patch-openrouter-session.js).",
  "      if (c.provider === 'openrouter') {",
  '        const sid = cacheSessionId(req, body);',
  '        if (sid) {',
  '          payload.session_id = sid;',
  '        }',
  '      }',
  '',
].join('\n');

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-openrouter-session : aiModels.js illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-openrouter-session : déjà appliqué');
  process.exit(0);
}

for (const [label, anchor] of [
  ['aide', RUN_LINE],
  ['requête', STREAM_COMMENT],
]) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.warn(`patch-openrouter-session : ancre « ${label} » trouvée ${count} fois (attendu : 1), ignoré`);
    process.exit(0);
  }
}

src = src.replace(RUN_LINE, () => RUN_LINE + '\n' + helper);
src = src.replace(STREAM_COMMENT, () => usage + STREAM_COMMENT);

fs.writeFileSync(file, src);
console.log('patch-openrouter-session : appliqué');
