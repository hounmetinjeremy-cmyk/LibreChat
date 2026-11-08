/**
 * Branche dans le proxy des modèles (api/server/routes/aiModels.js), avant chaque envoi au fournisseur :
 *  - l'allègement de l'historique (api/server/routes/historyTrim.js) : anciennes sorties d'outils réduites ;
 *  - les tranches du quota du jour (trancheGate, défini dans patch-token-quota.snippet) : pause à la fin de chaque
 *    tranche, l'utilisateur envoie « reprendre » pour lancer la suivante. Sans trancheGate (patch du quota non
 *    appliqué), seul l'allègement est actif.
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

const TRANCHE_GATE = [
  "    if (typeof trancheGate === 'function') {",
  '      const trancheMsg = await trancheGate(quotaUserOf(req), body);',
  '      if (trancheMsg) {',
  '        return res.status(429).json(err(trancheMsg));',
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
    '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n    body.messages = trimHistory(body.messages);\n' + TRANCHE_GATE,
  ],
]);
