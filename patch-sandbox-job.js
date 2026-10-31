/**
 * Branche le suivi en direct des tâches (/api/sandbox-job) dans api/server/index.js.
 * Le chargement est protég : si le fichier de routes plante, l'application démarre quand même.
 * Si l'ancre est introuvable, le patch est ignoré avec un avertissement (le build continue).
 */
const fs = require('fs');

const file = 'api/server/index.js';
let src = fs.readFileSync(file, 'utf8');
const anchor = "app.use('/api/keys', routes.keys);";

if (src.includes('./routes/sandboxJob')) {
  console.log('patch-sandbox-job : déjà appliqué');
} else if (!src.includes(anchor)) {
  console.warn('patch-sandbox-job : ancre introuvable, patch ignoré');
} else {
  const block = [
    anchor,
    '  try {',
    "    app.use('/api/sandbox-job', require('./routes/sandboxJob'));",
    '  } catch (sandboxJobError) {',
    "    logger.error('[sandbox-job] chargement impossible', sandboxJobError);",
    '  }',
  ].join('\n');
  src = src.replace(anchor, () => block);
  fs.writeFileSync(file, src);
  console.log('patch-sandbox-job : appliqué');
}
