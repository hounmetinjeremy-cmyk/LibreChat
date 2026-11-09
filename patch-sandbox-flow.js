/**
 * Consigne ajoutée au terminal : laisser Cloudflare Pages (ou Vercel) construire le site à la place du
 * conteneur de 1 Go ; le terminal sert aux tests et aux erreurs. Texte volontairement TRÈS court : il est
 * renvoyé au modèle à chaque appel et compte dans la fenêtre de contexte (Max Context Tokens).
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'clone --depth 1';
const anchor = 'Entre les commandes, écris au plus une phrase.';
const addition =
  "Clone avec git clone --depth 1. Site relié à Cloudflare Pages ou Vercel (sinon link_pages) : git push sans build local, puis vérifie le déploiement par l'API (Cloudflare : /accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/NOM/deployments, Bearer $CLOUDFLARE_API_TOKEN ; journaux : .../deployments/ID/history/logs). Terminal = tests et erreurs. ";

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
