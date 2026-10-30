/**
 * Branche la connexion GitHub intégrée (/api/github-link) dans api/server/index.js.
 * Si l'ancre est introuvable, le patch est ignoré avec un avertissement (le build continue).
 */
const fs = require('fs');

const file = 'api/server/index.js';
let src = fs.readFileSync(file, 'utf8');
const anchor = "app.use('/api/keys', routes.keys);";

if (src.includes('./routes/githubLink')) {
  console.log('patch-github-link : déjà appliqué');
} else if (!src.includes(anchor)) {
  console.warn('patch-github-link : ancre introuvable, patch ignoré');
} else {
  src = src.replace(
    anchor,
    () => `${anchor}\n  app.use('/api/github-link', require('./routes/githubLink'));`,
  );
  fs.writeFileSync(file, src);
  console.log('patch-github-link : appliqué');
}
