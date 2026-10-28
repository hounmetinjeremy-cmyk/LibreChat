// Patch de build : réduit les tokens envoyés au modèle à chaque message.
// 1) Ne garde que les N derniers messages (MAX_HISTORY_MESSAGES, défaut 2 ; 0 = pas de limite).
// 2) Tronque chaque ancien message à C caractères (MAX_HISTORY_CHARS, défaut 1200).
// Le dernier message (le tien) n'est jamais tronqué.
// Si le code de LibreChat a changé et que le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue normalement.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'app', 'clients', 'BaseClient.js');
const anchor = '    return this.addPreviousAttachments(_messages);';
const marker = 'MAX_HISTORY_MESSAGES';

const injection = `    const maxHistoryMessages = parseInt(process.env.MAX_HISTORY_MESSAGES ?? '2', 10);
    if (maxHistoryMessages > 0 && _messages.length > maxHistoryMessages) {
      _messages = _messages.slice(-maxHistoryMessages);
      while (_messages.length > 1 && !_messages[0].isCreatedByUser) {
        _messages.shift();
      }
    }
    try {
      const maxHistoryChars = parseInt(process.env.MAX_HISTORY_CHARS ?? '1200', 10);
      if (maxHistoryChars > 0) {
        for (let i = 0; i < _messages.length - 1; i++) {
          const m = _messages[i];
          if (m && typeof m.text === 'string' && m.text.length > maxHistoryChars) {
            _messages[i] = { ...m, text: m.text.slice(0, maxHistoryChars) + ' [...]' };
          }
        }
      }
    } catch (e) {
      console.warn('[patch-history-limit] troncature ignorée', e);
    }
`;

const source = fs.readFileSync(file, 'utf8');
if (source.includes(marker)) {
  console.log('[patch-history-limit] déjà appliqué');
} else if (source.split(anchor).length !== 2) {
  console.warn("[patch-history-limit] point d'insertion introuvable, patch ignoré");
} else {
  fs.writeFileSync(file, source.replace(anchor, injection + anchor));
  console.log('[patch-history-limit] appliqué');
}
