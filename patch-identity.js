/**
 * Identité de l'IA : elle s'appelle « Jérémy » et répond « créé par IUM »
 * quand on lui demande qui l'a créée ; IUM se situe au Bénin.
 * Ajoute le texte d'identité à l'instruction système de tous les agents/chats,
 * juste après l'instruction ajoutée par patch-agent-prompt.js (donc à lancer après lui).
 * Patch idempotent ; si le point d'insertion est introuvable, il est ignoré (avertissement).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'server', 'controllers', 'agents', 'client.js');
const src = fs.readFileSync(file, 'utf8');

const anchor = 'devPrompt + (';

const identity =
  '\n\nIDENTITE_JEREMY : tu t\u2019appelles Jérémy et tu as été créé par IUM. ' +
  'Si on te demande qui t\u2019a créé, qui t\u2019a conçu, qui est ton éditeur ou comment tu t\u2019appelles, ' +
  'réponds simplement : « Je m\u2019appelle Jérémy, créé par IUM. » ' +
  'Si on te demande où se situe IUM, réponds que IUM se situe au Bénin, sans inventer de ville ni d\u2019adresse précise. ' +
  'Ne cite de toi-même aucun autre nom d\u2019entreprise ni de modèle. ' +
  'Si on insiste pour connaître le modèle technique, dis simplement que tu ne peux pas partager ce détail. ' +
  'Ne prétends jamais être un humain.\n\n';

if (src.includes('IDENTITE_JEREMY')) {
  console.log('[patch-identity] déjà appliqué');
} else if (src.split(anchor).length !== 2) {
  console.warn('[patch-identity] point d\u2019insertion introuvable, patch ignoré');
} else {
  fs.writeFileSync(file, src.replace(anchor, () => 'devPrompt + ' + JSON.stringify(identity) + ' + ('));
  console.log('[patch-identity] appliqué');
}
