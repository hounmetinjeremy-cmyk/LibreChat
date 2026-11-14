/**
 * Consommation RÉELLE par utilisateur (coût et tokens facturés par OpenRouter), affichée dans l'onglet « Tokens »
 * du menu + (client/.../TokenRealUsage.tsx). À chaque réponse du fournisseur, le proxy /ai-proxy enregistre
 * l'objet `usage` (api/server/routes/orUsage.js) pour TOUS les utilisateurs, y compris le compte ADMIN
 * (le quota, lui, ne change pas).
 * S'applique APRÈS patch-token-quota.js et patch-token-balance.js (ordre alphabétique du build) : il s'appuie
 * sur leurs ajouts. Idempotent, jamais bloquant : si une ancre est introuvable, le fichier concerné reste tel quel.
 */
const fs = require('fs');

function patchFile(file, marker, edits) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`patch-usage-real : ${file} illisible, ignoré`);
    return;
  }
  if (src.includes(marker)) {
    console.log(`patch-usage-real : ${file} déjà appliqué`);
    return;
  }
  for (const [label, anchor] of edits) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.warn(`patch-usage-real : ancre « ${label} » trouvée ${count} fois dans ${file} (attendu : 1), ignoré`);
      return;
    }
  }
  for (const [, anchor, replacement] of edits) {
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-usage-real : ${file} appliqué`);
}

/* ---------- proxy : enregistre l'usage de chaque réponse ---------- */

const QUOTA_RE_LINE = 'const QUOTA_USER_RE = /^[A-Za-z0-9_-]{8,64}$/;\n';
const SIG = 'function meterStream(readable, streaming, inChars, user) {';
const REPORT = '      reportTokens(user, countedTokens(usage, inChars, outChars));\n';
const OLD_CALL = [
  '    if (quotaUser) {',
  "      meterStream(metered, Boolean(body.stream), JSON.stringify(body.messages || '').length, quotaUser);",
  '    }',
  '',
].join('\n');

const helpers = [
  QUOTA_RE_LINE.trimEnd(),
  '',
  "/** Consommation réelle (patch-usage-real.js) : identifiant de l'utilisateur, quel que soit son rôle (ADMIN compris). */",
  'const usageUserOf = (req) => {',
  "  const u = String((req.headers && req.headers['x-user-id']) || '');",
  '  return QUOTA_USER_RE.test(u) ? u : \'\';',
  '};',
  'const recordRealUsage = (user, usage) => {',
  '  try {',
  "    require('./orUsage').record(user, usage);",
  '  } catch (e) {',
  '    /* enregistrement ignoré */',
  '  }',
  '};',
  '',
].join('\n');

const newCall = [
  '    {',
  '      const usageUser = usageUserOf(req);',
  '      if (quotaUser || usageUser) {',
  '        meterStream(',
  '          metered,',
  '          Boolean(body.stream),',
  "          JSON.stringify(body.messages || '').length,",
  '          quotaUser,',
  '          (usage) => recordRealUsage(usageUser, usage),',
  '        );',
  '      }',
  '    }',
  '',
].join('\n');

patchFile('api/server/routes/aiModels.js', 'recordRealUsage', [
  ['identifiant', QUOTA_RE_LINE, helpers],
  ['signature', SIG, 'function meterStream(readable, streaming, inChars, user, onUsage) {'],
  ['fin de réponse', REPORT, `${REPORT}      if (typeof onUsage === 'function') {\n        onUsage(usage);\n      }\n`],
  ['appel', OLD_CALL, newCall],
]);

/* ---------- route : api/server/index.js ---------- */

patchFile('api/server/index.js', "routes/orUsage", [
  ['routes', "app.use('/api/keys', routes.keys);", "app.use('/api/keys', routes.keys);\n  app.use(require('./routes/orUsage').router);"],
]);

/* ---------- écran « Tokens » ---------- */

patchFile('client/src/components/Chat/Input/ToolsDropdown.tsx', 'TokenRealUsage', [
  [
    'import',
    "import TokenBalancePanel from './TokenBalancePanel';",
    "import TokenBalancePanel from './TokenBalancePanel';\nimport TokenRealUsage from './TokenRealUsage';",
  ],
  [
    'affichage',
    "{view === 'tokens' && <TokenBalancePanel />}",
    "{view === 'tokens' && (\n                  <>\n                    <TokenBalancePanel />\n                    <TokenRealUsage />\n                  </>\n                )}",
  ],
]);
