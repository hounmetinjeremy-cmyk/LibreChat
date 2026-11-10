/**
 * Garde-fou contre les boucles d'auto-correction : un fichier à la fois, au plus 2 tentatives automatiques de
 * correction quand une commande du terminal ou un outil MCP échoue ; après le 2e échec, l'IA s'arrête, montre
 * l'erreur exacte et demande à l'utilisateur ce qu'il veut faire. Texte court : il est renvoyé au modèle à chaque appel.
 * Appliqué au build (le Dockerfile exécute tous les patch-*.js). Jamais bloquant : si l'ancre est introuvable,
 * librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'Garde-fou : traite un fichier à la fois';
const anchor = 'Entre les commandes, écris au plus une phrase.';
const addition =
  "Garde-fou : traite un fichier à la fois. Si une commande ou un outil échoue, tu as au plus 2 tentatives de correction ; après le 2e échec, arrête-toi, montre l'erreur exacte en une ligne et demande à l'utilisateur ce qu'il veut faire. ";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-circuit-breaker : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-circuit-breaker : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-circuit-breaker : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => addition + anchor));
console.log('patch-circuit-breaker : appliqué');
