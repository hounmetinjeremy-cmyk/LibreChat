// Patch de build : réduit les tokens envoyés et reçus à chaque message.
// 1) Historique envoyé au modèle = TOUTE la conversation résumée en 4 lignes (5 au plus) + ton message actuel.
//    Variable HISTORY_SUMMARY_LINES (défaut 4, de 2 à 5 ; 0 = pas de résumé, historique complet).
// 2) Sortie automatique : réponse limitée à 1200 tokens (variable CHAT_MAX_OUTPUT),
//    SAUF si ton message demande du code : alors aucune limite.
// Tout est local : aucune requête supplémentaire, aucun token en plus.
// Si le code de LibreChat a changé et que le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue normalement.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'app', 'clients', 'BaseClient.js');
const anchor = '    return this.addPreviousAttachments(_messages);';
const marker = 'HISTORY_SUMMARY_LINES';

const injection = `    try {
      const lastMsg = _messages[_messages.length - 1];
      const askText = lastMsg && typeof lastMsg.text === 'string' ? lastMsg.text : '';
      const wantsCode = /\`\`\`|\\b(code|codes|coder|coder|script|scripts|fonction|function|composant|component|fichier|file|bug|erreur|error|corrige|corriger|fix|programme|html|css|javascript|typescript|python|sql|react|worker|api|endpoint|migration|workflow|yaml|json)\\b/i.test(askText);
      const chatMax = parseInt(process.env.CHAT_MAX_OUTPUT ?? '1200', 10);
      if (this.modelOptions && typeof this.modelOptions === 'object' && chatMax > 0) {
        if (wantsCode) {
          delete this.modelOptions.max_tokens;
        } else {
          this.modelOptions.max_tokens = chatMax;
        }
      }
    } catch (e) {
      console.warn('[patch-history-limit] limite de sortie ignorée', e);
    }
    try {
      const summaryOn = parseInt(process.env.HISTORY_SUMMARY_LINES ?? '4', 10);
      if (summaryOn > 0 && _messages.length > 1) {
        const maxLines = Math.min(5, Math.max(2, summaryOn));
        const clip = (t, n) => String(t ?? '').replace(/\\s+/g, ' ').trim().slice(0, n);
        const isText = (m) => m && typeof m.text === 'string' && m.text.length > 0;
        const last = _messages[_messages.length - 1];
        const older = _messages.slice(0, -1);
        const users = older.filter((m) => m.isCreatedByUser && isText(m));
        const bots = older.filter((m) => !m.isCreatedByUser && isText(m));
        // Toute la conversation tient en 4 lignes (5 au plus) : chaque ligne a une priorité, on garde les plus utiles.
        const cands = [];
        if (users.length > 1) cands.push({ order: 1, prio: 2, t: 'Objectif : ' + clip(users[0].text, 110) + '.' });
        if (users.length > 2) cands.push({ order: 2, prio: 4, t: 'Avant : ' + clip(users[users.length - 2].text, 90) + '.' });
        if (users.length > 0) cands.push({ order: 3, prio: 1, t: 'Dernière demande : ' + clip(users[users.length - 1].text, 110) + '.' });
        if (bots.length > 0) cands.push({ order: 4, prio: 1, t: 'Dernière réponse : ' + clip(bots[bots.length - 1].text, 140) + '.' });
        const seen = new Set();
        const all = users.concat(bots).map((m) => m.text).join(' ');
        (all.match(/[\\w./-]+\\.(?:js|ts|tsx|jsx|json|py|html|css|md|ya?ml|toml|sql|sh|txt)\\b/g) || []).slice(-30).forEach((f) => seen.add(f));
        const files = Array.from(seen).slice(-6);
        if (files.length > 0) cands.push({ order: 5, prio: 3, t: 'Fichiers cités : ' + files.join(', ') + '.' });
        const lines = cands
          .sort((a, b) => a.prio - b.prio || a.order - b.order)
          .slice(0, maxLines)
          .sort((a, b) => a.order - b.order)
          .map((c) => c.t);
        if (lines.length > 0 && last.isCreatedByUser && typeof last.text === 'string') {
          _messages = [
            { ...last, text: '[Résumé de la conversation, ' + older.length + ' messages avant]\\n' + lines.join('\\n') + '\\n\\n[Message actuel]\\n' + last.text },
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
