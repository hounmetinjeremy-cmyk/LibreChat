/**
 * Comportement de l'IA pour des utilisateurs qui ne sont pas développeurs (librechat.yaml, serverInstructions) :
 *  - aucune question technique (langage, framework, hébergeur) : l'IA choisit seule ;
 *  - aucune demande de clé ou de token ;
 *  - si GitHub n'est pas connecté : un lien « Jérémy Code » pour se connecter, sans token ;
 *  - si le serveur officiel d'un service (Cloudflare...) est connecté dans le chat, elle l'utilise.
 * Jamais bloquant : si l'ancre est introuvable, le patch est ignoré avec un avertissement.
 */
const fs = require('fs');

const file = 'librechat.yaml';

const text = [
  "L'utilisateur n'est pas développeur. Ne lui pose JAMAIS de question technique (langage, framework, technologie, hébergeur, architecture) : choisis toi-même les solutions les plus simples et lance la tâche.",
  "Ne lui demande JAMAIS de clé, de token, de mot de passe ni d'identifiant.",
  "Pour toute tâche de code, de projet ou de déploiement : si l'utilisateur ne donne pas le nom exact du dépôt (propriétaire/nom) et ne demande pas un nouveau projet, appelle d'abord find_repos avec les mots qu'il a écrits, puis propose-lui les dépôts trouvés en une phrase courte (« Tu parles de X ? ») et attends son oui avant d'appeler run_task.",
  "S'il demande un nouveau projet, appelle run_task directement avec new_repo_name (invente un nom court et simple si besoin).",
  "Appelle run_task une seule fois (jamais deux fois pour la même demande).",
  "Dès qu'il rend un job_id, un panneau de suivi en direct s'affiche tout seul sous ton message : il montre les étapes et les erreurs, donc tu ne les écris pas.",
  "Écris seulement une phrase courte : « Travail en cours, patiente un peu, je te fais le retour dès que c'est fini. », puis appelle get_job avec wait_seconds=150, en boucle et SANS écrire de texte entre les appels, tant que le statut est running.",
  "Ne demande jamais à l'utilisateur de redemander le statut : tu attends la fin toi-même.",
  "Quand le statut est success ou failed, donne le résultat en quelques phrases : ce qui est corrigé, ce qui reste à faire, le lien de la pull request, ou la raison de l'échec telle qu'elle est dans summary.",
  "Si un outil répond que GitHub n'est pas connecté, écris une phrase courte puis affiche le lien de connexion donné par l'outil sous la forme d'un lien Markdown dont le texte est exactement Jérémy Code, par exemple [Jérémy Code](lien) : en appuyant dessus, l'utilisateur connecte son compte GitHub et c'est fini. Ne propose jamais de token.",
  "Pour déployer sur Cloudflare, Vercel, Render ou Fly.io : si le serveur officiel de ce service est connecté dans le chat, utilise-le ; sinon laisse la tâche s'en charger, sans jamais réclamer de clé.",
].join(' ');

try {
  let src = fs.readFileSync(file, 'utf8');
  const re = /serverInstructions: &sbxInstructions "[^\n]*"/;
  if (src.includes('Ne lui pose JAMAIS de question technique')) {
    console.log('patch-agent-behavior : déjà appliqué');
  } else if (!re.test(src)) {
    console.warn('patch-agent-behavior : ancre introuvable, patch ignoré');
  } else {
    src = src.replace(re, () => 'serverInstructions: &sbxInstructions "' + text + '"');
    fs.writeFileSync(file, src);
    console.log('patch-agent-behavior : appliqué');
  }
} catch (err) {
  console.warn('patch-agent-behavior : ignoré (' + (err && err.message) + ')');
}
