/**
 * Branche les modèles gérés par la page admin dans api/server/index.js :
 * - la route interne /ai-proxy, montée AVANT le lecteur JSON de LibreChat (limite de 3 Mo
 *   sinon, trop petite pour les photos) ;
 * - l'API /api/admin-models.
 * Si une ancre est introuvable, le patch est ignoré avec un avertissement (le build continue).
 */
const fs = require('fs');

const file = 'api/server/index.js';
let src = fs.readFileSync(file, 'utf8');

const anchorRoutes = "app.use('/api/keys', routes.keys);";
const jsonRe = /^([ \t]*)app\.use\(express\.json\(/m;

if (src.includes('./routes/aiModels')) {
  console.log('patch-ai-models : déjà appliqué');
} else if (!src.includes(anchorRoutes)) {
  console.warn('patch-ai-models : ancre introuvable, patch ignoré');
} else {
  let proxyEarly = false;
  src = src.replace(jsonRe, (match, indent) => {
    proxyEarly = true;
    return `${indent}app.use(require('./routes/aiModels').proxyRouter);\n${match}`;
  });
  const extra = proxyEarly
    ? "\n  app.use(require('./routes/aiModels').adminRouter);"
    : "\n  app.use(require('./routes/aiModels').proxyRouter);\n  app.use(require('./routes/aiModels').adminRouter);";
  if (!proxyEarly) {
    console.warn('patch-ai-models : lecteur JSON introuvable, limite de 3 Mo pour les images');
  }
  src = src.replace(anchorRoutes, () => `${anchorRoutes}${extra}`);
  fs.writeFileSync(file, src);
  console.log('patch-ai-models : appliqué');
}
