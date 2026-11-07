/**
 * Interface façon Claude (patch au build, avant la compilation du client) :
 *  1. Les outils dépliés (ToolCall.tsx) n'ont plus de cadre ni de fond : texte simple.
 *  2. Le logo du message (MessageParts.tsx) tourne tant que la réponse est en cours.
 * Jamais bloquant : si une ancre est introuvable, l'étape est ignorée avec un avertissement (le build continue).
 */
const fs = require('fs');

function patch(file, find, replacement, done, label) {
  try {
    const src = fs.readFileSync(file, 'utf8');
    if (src.includes(done)) {
      console.log('patch-claude-ui : ' + label + ' déjà appliqué');
      return;
    }
    const next = src.replace(find, replacement);
    if (next === src) {
      console.warn('patch-claude-ui : ' + label + ' ancre introuvable, ignoré');
      return;
    }
    fs.writeFileSync(file, next);
    console.log('patch-claude-ui : ' + label + ' appliqué');
  } catch (err) {
    console.warn('patch-claude-ui : ' + label + ' ignoré (' + (err && err.message) + ')');
  }
}

// 1) Plus de contour autour du détail d'un outil.
patch(
  'client/src/components/Chat/Messages/Content/ToolCall.tsx',
  "'overflow-hidden rounded-lg border border-border-light bg-surface-secondary'",
  "'overflow-hidden pl-1 text-text-secondary'",
  "'overflow-hidden pl-1 text-text-secondary'",
  'outils sans contour'
);

// 2) Logo qui tourne pendant que le dernier message est en cours de génération.
patch(
  'client/src/components/Chat/Messages/MessageParts.tsx',
  /(id=\{messageId \?\? ''\}\s*\n\s*)icon=\{(<MessageIcon iconData=\{iconData\} assistant=\{assistant\} agent=\{agent\} \/>)\}/,
  "$1icon={<span className={isSubmitting && messageId === latestMessageId ? 'inline-flex animate-[spin_2s_linear_infinite]' : 'inline-flex'}>$2</span>}",
  'animate-[spin_2s_linear_infinite]',
  'logo animé'
);
