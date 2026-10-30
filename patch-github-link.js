/**
 * Branche la connexion GitHub intégrée (/api/github-link et /.well-known) dans api/server/index.js.
 * Le chargement est protégé : si le fichier de routes plante, l'application démarre quand même.
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
  const block = [
    anchor,
    '  try {',
    "    const githubLink = require('./routes/githubLink');",
    '    app.use(githubLink.wellKnown);',
    "    app.use('/api/github-link', githubLink);",
    '  } catch (githubLinkError) {',
    "    logger.error('[github-link] chargement impossible', githubLinkError);",
    '  }',
  ].join('\n');
  src = src.replace(anchor, () => block);
  fs.writeFileSync(file, src);
  console.log('patch-github-link : appliqué');
}
