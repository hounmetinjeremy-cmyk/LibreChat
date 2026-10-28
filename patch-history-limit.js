// Patch de build : l'historique envoyé au modèle = résumé de 3 phrases + ton message actuel.
// Quel que soit le nombre de messages (10 ou 1000), le résumé garde toujours la même taille.
// Résumé fait localement (aucune requête supplémentaire, aucun token en plus) :
//   1) le sujet du départ (ta première question), 2) ta dernière question, 3) la dernière réponse.
// Variable HISTORY_SUMMARY_LINES (défaut 3 ; 0 = pas de résumé, historique complet).
// Si le code de LibreChat a changé et que le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue normalement.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'app', 'clients', 'BaseClient.js');
const anchor = '    return this.addPreviousAttachments(_messages);';
const marker = 'HISTORY_SUMMARY_LINES';

const injection = `    try {
      const summaryOn = parseInt(process.env.HISTORY_SUMMARY_LINES ?? '3', 10);
      if (summaryOn > 0 && _messages.length > 1) {
        const clip = (t, n) => String(t ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
        const isText = (m) => m && typeof m.text === 'string' && m.text.length > 0;
        const last = _messages[_messages.length - 1];
        const older = _messages.slice(0, -1);
        const users = older.filter((m) => m.isCreatedByUser && isText(m));
        const bots = older.filter((m) => !m.isCreatedByUser && isText(m));
        const parts = [];
        if (users.length > 1) parts.push('Début de la discussion : ' + clip(users[0].text, 100) + '.');
        if (users.length > 0) parts.push('Dernière question : ' + clip(users[users.length - 1].text, 100) + '.');
        if (bots.length > 0) parts.push('Dernière réponse : ' + clip(bots[bots.length - 1].text, 120) + '.');
        if (parts.length > 0 && last.isCreatedByUser && typeof last.text === 'string') {
          _messages = [
            { ...last, text: '[Résumé de la conversation, ' + older.length + ' messages avant]\\n' + parts.join(' ') + '\\n\\n[Message actuel]\\n' + last.text },
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
