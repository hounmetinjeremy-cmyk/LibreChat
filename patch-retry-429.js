/**
 * Relance automatique quand le fournisseur répond 429 (limite de débit transitoire).
 * Une tâche à plusieurs étapes renvoie tout l'historique à chaque appel : le fournisseur peut
 * refuser quelques secondes puis réaccepter. Sans relance, LibreChat affiche tout de suite
 * « The provider declined this request for exceeding a rate or spending limit ».
 * Ici : jusqu'à 3 nouveaux essais (2 s, 5 s, 10 s, ou l'en-tête Retry-After, plafonné à 15 s),
 * dans la route interne /ai-proxy (api/server/routes/aiModels.js).
 * Appliqué au build (le Dockerfile exécute tous les patch-*.js). Jamais bloquant : si l'ancre est
 * introuvable, le fichier reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'fetchRetry429';
const fetchAnchor = '        up = await fetch(c.url, {';
const helperAnchor = 'async function handleChat(req, res) {';

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-retry-429 : aiModels.js illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-retry-429 : déjà appliqué');
  process.exit(0);
}

const count = (needle) => src.split(needle).length - 1;
if (count(fetchAnchor) !== 1 || count(helperAnchor) !== 1) {
  console.warn(
    `patch-retry-429 : ancres trouvées ${count(fetchAnchor)} / ${count(helperAnchor)} fois (attendu : 1 / 1), ignoré`,
  );
  process.exit(0);
}

const helper = [
  '/** Relance sur 429 (limite de débit transitoire du fournisseur), patch-retry-429.js. */',
  'const RETRY_429_DELAYS_MS = [2000, 5000, 10000];',
  'const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
  'async function fetchRetry429(url, init) {',
  '  let r = await fetch(url, init);',
  '  for (const base of RETRY_429_DELAYS_MS) {',
  '    if (r.status !== 429) {',
  '      return r;',
  '    }',
  "    const ra = Number(r.headers.get('retry-after'));",
  '    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 15000) : base;',
  '    try {',
  '      if (r.body) {',
  '        await r.body.cancel();',
  '      }',
  '    } catch (e) {',
  '      /* ignoré */',
  '    }',
  "    logger.warn('[aiModels] 429 du fournisseur, nouvel essai dans ' + Math.round(wait / 1000) + ' s');",
  '    await sleepMs(wait);',
  '    r = await fetch(url, init);',
  '  }',
  '  return r;',
  '}',
  '',
  '',
].join('\n');

src = src.replace(helperAnchor, () => helper + helperAnchor);
src = src.replace(fetchAnchor, () => '        up = await fetchRetry429(c.url, {');

fs.writeFileSync(file, src);
console.log('patch-retry-429 : appliqué');
