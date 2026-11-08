/**
 * Branche dans le proxy des modèles (api/server/routes/aiModels.js), avant chaque envoi au fournisseur :
 *  - l'allègement de l'historique (api/server/routes/historyTrim.js) : anciennes sorties d'outils réduites ;
 *  - le rythme de tokens par utilisateur (paceGate, défini dans patch-token-quota.snippet) : le quota du jour doit durer
 *    environ 18 heures. Sans paceGate (patch du quota non appliqué), seul l'allègement est actif.
 * Idempotent. Si une ancre est introuvable, le build échoue volontairement (l'ancienne version reste en ligne).
 */
const fs = require('fs');

function patchFile(file, marker, edits) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) {
    console.log(`patch-history : ${file} déjà appliqué`);
    return;
  }
  for (const [label, anchor, replacement] of edits) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.error(`patch-history : ancre « ${label} » trouvée ${count} fois dans ${file} (attendu : 1)`);
      process.exit(1);
    }
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-history : ${file} appliqué`);
}

const PACE_GATE = [
  "    if (typeof paceGate === 'function') {",
  '      const paceMsg = await paceGate(quotaUserOf(req));',
  '      if (paceMsg) {',
  '        return res.status(429).json(err(paceMsg));',
  '      }',
  '    }',
  '',
].join('\n');

patchFile('api/server/routes/aiModels.js', "require('./historyTrim')", [
  [
    'import',
    "const requireJwtAuth = require('../middleware/requireJwtAuth');\n",
    "const requireJwtAuth = require('../middleware/requireJwtAuth');\nconst { trimHistory } = require('./historyTrim');\n",
  ],
  [
    'appel',
    '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n',
    '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n    body.messages = trimHistory(body.messages);\n' + PACE_GATE,
  ],
]);
