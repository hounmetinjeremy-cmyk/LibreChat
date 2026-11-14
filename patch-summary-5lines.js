/**
 * Point d'étape automatique de la conversation : 5 lignes au lieu de 10.
 * Le texte de la consigne est déjà dans api/server/routes/aiModels.js (posé par patch-short-summary.js, donc ce
 * patch-là ne le modifie plus une fois appliqué) : celui-ci remplace les passages « 10 lignes maximum (environ
 * 200 mots) » par « 5 lignes maximum (environ 80 mots), une ligne par titre » et la limite de 600 tokens par 300.
 * Le résumé de l'HISTORIQUE (4 lignes) est dans patch-history-limit.js ; celui-ci ne sert que lorsque LibreChat
 * demande lui-même un point d'étape au milieu d'une longue tâche.
 * Idempotent, jamais bloquant : si un passage est introuvable, aiModels.js reste tel quel (avertissement).
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = '5 lignes maximum (environ 80 mots)';

const edits = [
  [
    "en UN SEUL texte de 10 lignes maximum (environ 200 mots), même format : But, Fait, Reste à faire, À garder tel quel.",
    "en UN SEUL texte de 5 lignes maximum (environ 80 mots), une ligne par titre : But, Fait, Reste à faire, À garder tel quel.",
  ],
  [
    "Réponds seulement par le point d'étape, 10 lignes maximum (environ 200 mots), phrases courtes, avec ces titres :",
    "Réponds seulement par le point d'étape, 5 lignes maximum (environ 80 mots), une ligne par titre, avec ces titres :",
  ],
  ['body.max_tokens = 600;', 'body.max_tokens = 300;'],
];

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-summary-5lines : aiModels.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-summary-5lines : déjà appliqué');
  process.exit(0);
}
for (const [from] of edits) {
  const count = src.split(from).length - 1;
  if (count !== 1) {
    console.warn(`patch-summary-5lines : passage trouvé ${count} fois (attendu : 1), ignoré : ${from.slice(0, 50)}`);
    process.exit(0);
  }
}
for (const [from, to] of edits) {
  src = src.replace(from, () => to);
}
fs.writeFileSync(file, src);
console.log('patch-summary-5lines : appliqué');
