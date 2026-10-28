// Patch de build : l'historique envoyé au modèle = un résumé de 4 lignes + ton dernier message.
// Résumé fait localement (aucune requête supplémentaire, aucun token en plus) :
// une ligne par échange récent (début de ta question + début de la réponse).
// Variable HISTORY_SUMMARY_LINES (défaut 4 ; 0 = pas de résumé, historique complet).
// Si le code de LibreChat a changé et que le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue normalement.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'app', 'clients', 'BaseClient.js');
const anchor = '    return this.addPreviousAttachments(_messages);';
const marker = 'HISTORY_SUMMARY_LINES';

const injection = `    try {
      const summaryLines = parseInt(process.env.HISTORY_SUMMARY_LINES ?? '4', 10);
      if (summaryLines > 0 && _messages.length > 1) {
        const clip = (t, n) => String(t ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
        const last = _messages[_messages.length - 1];
        const older = _messages.slice(0, -1);
        const exchanges = [];
        for (let i = 0; i < older.length; i++) {
          if (!older[i].isCreatedByUser || typeof older[i].text !== 'string') continue;
          const next = older[i + 1];
          const answer = next && !next.isCreatedByUser && typeof next.text === 'string' ? clip(next.text, 90) : '';
          exchanges.push('- Question : ' + clip(older[i].text, 70) + ' | Réponse : ' + answer);
        }
        const lines = exchanges.slice(-summaryLines);
        if (lines.length > 0 && last.isCreatedByUser && typeof last.text === 'string') {
          _messages = [
            { ...last, text: '[Résumé de la conversation]\\n' + lines.join('\\n') + '\\n\\n[Message actuel]\\n' + last.text },
          ];
        }
      }
    } catch (e) {
      console.warn('[patch-history-limit] résumé ignoré', e);
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
