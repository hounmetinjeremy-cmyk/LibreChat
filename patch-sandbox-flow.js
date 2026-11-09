/**
 * Consigne ajoutée au terminal : ne pas construire le site complet dans le conteneur de 1 Go ; Cloudflare Pages
 * (ou Vercel) le construit après le dépôt. Texte volontairement TRÈS court : il est renvoyé au modèle à chaque
 * appel et compte dans la fenêtre de contexte. La méthode générale (GitHub pour écrire, Cloudflare/Vercel pour
 * déployer, terminal pour tester) est dans patch-sandbox-method.js.
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'clone --depth 1';
const anchor = 'Entre les commandes, écris au plus une phrase.';
const addition =
  "Clone avec git clone --depth 1. Ne construis pas le site complet ici : Cloudflare Pages ou Vercel le construit après le dépôt (sinon link_pages). Vérifie le déploiement par l'API (Cloudflare : /accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/NOM/deployments, Bearer $CLOUDFLARE_API_TOKEN ; journaux : .../deployments/ID/history/logs). ";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-sandbox-flow : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-sandbox-flow : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-sandbox-flow : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => addition + anchor));
console.log('patch-sandbox-flow : appliqué');
