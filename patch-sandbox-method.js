/**
 * Méthode de travail de l'IA : le code s'écrit et les projets se créent avec le serveur MCP GitHub à 21 outils
 * (déployé sur Cloudflare Workers, ajouté dans les paramètres admin sous le nom « GitHub »), le déploiement se
 * fait avec Cloudflare Pages ou Vercel (leurs serveurs MCP), et le terminal sert UNIQUEMENT à tester (clone,
 * installation, tests, build) et à trouver l'erreur et sa ligne ; la correction est écrite à nouveau avec ce
 * serveur, puis git pull et nouveau test. Remplace la phrase qui demandait de tout faire dans le terminal.
 * Le petit serveur « github » de librechat.yaml (un seul outil) n'est PAS utilisé : le texte désigne le bon
 * serveur par ses outils (create_or_update_file, push_files, create_repository), pas par son nom.
 * Texte court : il est renvoyé au modèle à chaque appel.
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'MÉTHODE (prioritaire)';
const anchor =
  'Tout se fait par commandes, une étape à la fois, en lisant chaque résultat avant la suivante : git clone, lecture et écriture de fichiers (cat, sed, heredoc), installation, tests, build, déploiement, git commit et push.';
const replacement =
  "MÉTHODE (prioritaire) : le code s'écrit et les projets se créent avec le serveur GitHub qui offre create_or_update_file, push_files et create_repository (jamais avec le petit serveur github à un seul outil) ; le déploiement se fait avec les outils Cloudflare Pages ou Vercel. Le terminal sert UNIQUEMENT à tester : git clone, installation, tests, build ; il te montre l'erreur et sa ligne, tu corriges avec ces outils GitHub (pas avec cat, sed ou heredoc), puis git pull et nouveau test. Si GitHub, Cloudflare ou Vercel n'est pas connecté, dis à l'utilisateur de le connecter (menu +) ; commit et push depuis le terminal seulement en dernier recours. Tu lis chaque résultat avant l'étape suivante.";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-sandbox-method : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-sandbox-method : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-sandbox-method : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => replacement));
console.log('patch-sandbox-method : appliqué');
