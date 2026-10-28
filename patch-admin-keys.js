/**
 * Branche la page admin « /admin-config » et le chargement des clés dans api/server/index.js.
 * Si une ancre est introuvable, le build échoue volontairement (l'ancienne version reste en ligne).
 */
require('./patch-google-link.js');
require('./patch-identity.js');
require('./patch-admin-link.js');

const fs = require('fs');

const file = 'api/server/index.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes("./routes/adminKeys")) {
  console.log('patch-admin-keys : déjà appliqué');
  process.exit(0);
}

const anchorDb = "logger.info('Connected to MongoDB');";
const anchorRoutes = "app.use('/api/keys', routes.keys);";

if (!src.includes(anchorDb) || !src.includes(anchorRoutes)) {
  console.error('patch-admin-keys : ancres introuvables dans api/server/index.js');
  process.exit(1);
}

src = src.replace(
  anchorDb,
  () => `${anchorDb}\n  await require('./routes/adminKeys').applyStoredKeys();`,
);
src = src.replace(
  anchorRoutes,
  () => `${anchorRoutes}\n  app.use(require('./routes/adminKeys').router);`,
);

fs.writeFileSync(file, src);
console.log('patch-admin-keys : appliqué');
