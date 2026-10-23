// Patch de build : ne renvoie au modèle que les N derniers messages de l'historique.
// N = variable d'environnement MAX_HISTORY_MESSAGES (défaut 6 ; 0 = pas de limite).
// Si le code de LibreChat a changé et que le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue normalement.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'app', 'clients', 'BaseClient.js');
const anchor = '    return this.addPreviousAttachments(_messages);';
const marker = 'MAX_HISTORY_MESSAGES';

const injection = `    const maxHistoryMessages = parseInt(process.env.MAX_HISTORY_MESSAGES ?? '6', 10);
    if (maxHistoryMessages > 0 && _messages.length > maxHistoryMessages) {
      _messages = _messages.slice(-maxHistoryMessages);
      while (_messages.length > 1 && !_messages[0].isCreatedByUser) {
        _messages.shift();
      }
    }
`;

const source = fs.readFileSync(file, 'utf8');
if (source.includes(marker)) {
  console.log('[patch-history-limit] déjà appliqué');
} else if (source.split(anchor).length !== 2) {
  console.warn('[patch-history-limit] point d\'insertion introuvable, patch ignoré');
} else {
  fs.writeFileSync(file, source.replace(anchor, injection + anchor));
  console.log('[patch-history-limit] appliqué');
}
