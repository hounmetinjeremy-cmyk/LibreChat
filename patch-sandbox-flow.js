/**
 * Consigne ajoutée au terminal : gagner du temps en laissant Cloudflare Pages (ou Vercel) construire le site
 * à la place du conteneur de 1 Go. Le terminal sert aux tests et à comprendre les erreurs ; après un push,
 * l'IA vérifie le déploiement avec l'API du service (clé déjà dans l'environnement du terminal).
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'clone --depth 1';
const anchor = 'Entre les commandes, écris au plus une phrase.';
const addition =
  "Gain de temps : clone avec git clone --depth 1. Ne lance pas le build complet d'un site ici quand son dépôt est relié à Cloudflare Pages ou à Vercel (sinon relie-le d'abord avec link_pages) : fais git push, le service construit à ta place. Vérifie ensuite le déploiement avec curl (Cloudflare : GET https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/NOM/deployments, en-tête Authorization: Bearer $CLOUDFLARE_API_TOKEN ; si latest_stage est en échec, lis .../deployments/ID/history/logs ; Vercel : vercel ls et vercel inspect --logs). Le terminal sert aux tests et à comprendre les erreurs. ";

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
