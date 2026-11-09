/**
 * Consigne ajoutée au terminal : installer les paquets avec bun (cache préchauffé dans l'image du conteneur,
 * voir sandbox/worker/Dockerfile) au lieu de npm, bien plus lent sur un conteneur neuf à chaque session.
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'bun install';
const anchor = 'Commande longue (build, installation) :';
const addition =
  "Installer des paquets : utilise bun install (cache préchauffé, bien plus rapide que npm install) ; si bun échoue, repasse à npm install. ";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-sandbox-bun : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-sandbox-bun : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-sandbox-bun : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => addition + anchor));
console.log('patch-sandbox-bun : appliqué');
