/**
 * Mode « squelette » des outils MCP (TOOL_SLIM_MODE=skeleton) : en plus de patch-slim-tools.js, retire des schémas
 * envoyés au modèle toutes les descriptions de paramètres, les titres et les valeurs par défaut simples. Restent :
 * le nom de l'outil, une description de 80 caractères, les noms et types des paramètres, enum et champs obligatoires.
 * Le terminal (sandbox) et Google Drive restent intacts (déjà exemptés par patch-slim-tools.js : leurs descriptions
 * portent des consignes utiles, comme le base64 de create_file).
 * Sans TOOL_SLIM_MODE=skeleton, le comportement ne change pas. S'applique après patch-slim-tools.js.
 * Idempotent, jamais bloquant : si une ancre est introuvable, aiModels.js reste tel quel.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'TOOL_SLIM_MODE';

const edits = [
  [
    'description',
    '            if (k === "description" && typeof v === "string") out[k] = cut(v, depth === 0 ? 120 : 60);\n',
    [
      '            if (process.env.TOOL_SLIM_MODE === "skeleton" && ((k === "description" && typeof v === "string") || (k === "title" && typeof v === "string") || (k === "default" && (v === null || typeof v !== "object")))) continue;',
      '            if (k === "description" && typeof v === "string") out[k] = cut(v, depth === 0 ? 120 : 60);',
      '',
    ].join('\n'),
  ],
  [
    'outil',
    'description: cut(fn.description, 200), parameters: slim(fn.parameters, 0)',
    'description: cut(fn.description, process.env.TOOL_SLIM_MODE === "skeleton" ? 80 : 200), parameters: slim(fn.parameters, 0)',
  ],
];

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-slim-skeleton : aiModels.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-slim-skeleton : déjà appliqué');
  process.exit(0);
}
for (const [label, anchor] of edits) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.warn(`patch-slim-skeleton : ancre « ${label} » trouvée ${count} fois (attendu : 1), ignoré`);
    process.exit(0);
  }
}
for (const [, anchor, replacement] of edits) {
  src = src.replace(anchor, () => replacement);
}
fs.writeFileSync(file, src);
console.log('patch-slim-skeleton : appliqué');
