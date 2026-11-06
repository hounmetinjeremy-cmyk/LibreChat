/**
 * Branche la route /api/cloudflare-link (connexion Cloudflare, déploiement Pages) dans api/server/index.js.
 * Jamais bloquant : si l'ancre est introuvable, le patch est ignoré avec un avertissement.
 */
const fs = require('fs');

const file = 'api/server/index.js';
const anchor = "app.use('/api/keys', routes.keys);";

try {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('./routes/cloudflareLink')) {
    console.log('patch-cloudflare-link : déjà appliqué');
  } else if (!src.includes(anchor)) {
    console.warn('patch-cloudflare-link : ancre introuvable, patch ignoré');
  } else {
    src = src.replace(
      anchor,
      () => anchor + "\n  app.use('/api/cloudflare-link', require('./routes/cloudflareLink'));",
    );
    fs.writeFileSync(file, src);
    console.log('patch-cloudflare-link : appliqué');
  }
} catch (err) {
  console.warn('patch-cloudflare-link : ignoré (' + (err && err.message) + ')');
}
