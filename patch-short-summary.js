/**
 * Résumé automatique de la conversation (« Conversation résumée ») TRÈS COURT.
 * LibreChat demande au modèle un « checkpoint » avec une consigne fixe de la bibliothèque @librechat/agents
 * (DEFAULT_SUMMARIZATION_PROMPT, qui commence par « Hold on, before you continue I need you to write me a
 * checkpoint of everything so far », et DEFAULT_UPDATE_SUMMARIZATION_PROMPT, « Hold on again, update your
 * checkpoint »). Ce résumé dépassait 1 000 mots et saturait la fenêtre de contexte (Max Context Tokens).
 * La requête passe par /ai-proxy (api/server/routes/aiModels.js) : on y reconnaît la consigne exacte, on la
 * remplace par une consigne de 10 lignes maximum et on limite la réponse à 600 tokens. Le résumé précédent
 * (<previous-summary>) est conservé tel quel dans la consigne de mise à jour.
 * Seul le DERNIER message de la requête est examiné : une conversation normale n'est jamais modifiée.
 * Jamais bloquant : si l'ancre est introuvable, le fichier reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'patch-short-summary.js';
const anchor = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';

const block = String.raw`    // Résumé automatique de la conversation : la consigne est remplacée par une version très courte (patch-short-summary.js).
    try {
      const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
      if (lastMsg) {
        const lastText = typeof lastMsg.content === "string" ? lastMsg.content : Array.isArray(lastMsg.content) ? lastMsg.content.map((p) => (p && p.text) || "").join("\n") : "";
        const isFirst = /write me a checkpoint of everything so far/i.test(lastText);
        const isUpdate = /Hold on again/i.test(lastText) && /update your checkpoint/i.test(lastText);
        if (isFirst || isUpdate) {
          const prev = lastText.match(/<previous-summary>[\s\S]*<\/previous-summary>/);
          const shortPrompt = isUpdate
            ? "Mets à jour ton point d'étape précédent (voir <previous-summary>) en UN SEUL texte de 10 lignes maximum (environ 200 mots), même format : But, Fait, Reste à faire, À garder tel quel. Compresse l'ancien, n'ajoute pas. N'appelle aucun outil et ne continue pas la tâche. Réponds seulement par le point d'étape."
            : "Avant de continuer, écris un point d'étape ULTRA COURT de tout ce qui précède : il remplace les messages ci-dessus. N'appelle aucun outil et ne continue pas la tâche. Réponds seulement par le point d'étape, 10 lignes maximum (environ 200 mots), phrases courtes, avec ces titres : But / Fait / Reste à faire / À garder tel quel (noms de dépôts, chemins, adresses, erreurs exactes). Aucun journal de commandes.";
          lastMsg.content = shortPrompt + (prev ? "\n\n" + prev[0] : "");
          body.max_tokens = 600;
        }
      }
    } catch (e) {
      /* jamais bloquant */
    }
`;

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-short-summary : aiModels.js illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-short-summary : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-short-summary : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => anchor + block));
console.log('patch-short-summary : appliqué');
