/**
 * Lance le Ministre (proxy MCP) en même temps que LibreChat, dans le même conteneur Fly.
 * Le Ministre écoute uniquement en local (127.0.0.1:3090) : rien n'est exposé sur Internet.
 * Méthode : on préfixe le script « backend » de package.json avec « node ministre/server.js & ».
 * Si le Ministre plante, LibreChat continue de tourner (il est lancé en arrière-plan).
 * Idempotent, jamais bloquant : si le script est introuvable, rien n'est modifié (avertissement).
 */
const fs = require('fs');

const file = 'package.json';
const marker = 'ministre/server.js';

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.warn('patch-ministre : package.json illisible, ignoré');
  process.exit(0);
}

const current = pkg.scripts && pkg.scripts.backend;
if (!current) {
  console.warn('patch-ministre : script "backend" introuvable, ignoré');
  process.exit(0);
}
if (current.includes(marker)) {
  console.log('patch-ministre : déjà appliqué');
  process.exit(0);
}
if (!fs.existsSync(marker)) {
  console.warn('patch-ministre : dossier ministre/ absent, ignoré');
  process.exit(0);
}

pkg.scripts.backend = `node ${marker} & ${current}`;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('patch-ministre : appliqué');
