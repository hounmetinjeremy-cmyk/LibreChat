/**
 * Charge api/server/tuning.js (réglages d'économie de tokens écrits dans le code) tout au début de
 * api/server/index.js, avant le reste du serveur. Idempotent, jamais bloquant : si l'ancre est introuvable ou si
 * tuning.js est absent, index.js reste tel quel (avertissement) et les variables Fly continuent de s'appliquer.
 */
const fs = require('fs');

const file = 'api/server/index.js';
const marker = "require('./tuning')";
const anchor = "require('../config/credentials');\n";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-tuning : index.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-tuning : déjà appliqué');
  process.exit(0);
}
if (!fs.existsSync('api/server/tuning.js')) {
  console.warn('patch-tuning : tuning.js absent, ignoré');
  process.exit(0);
}
const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-tuning : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}
fs.writeFileSync(file, `${marker};\n${src.replace(anchor, () => anchor)}`);
console.log('patch-tuning : appliqué');
