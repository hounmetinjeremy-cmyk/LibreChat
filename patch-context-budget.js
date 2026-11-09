/**
 * Fenêtre de contexte par défaut pour Aube et Soleil : 24 000 tokens (Max Context Tokens).
 * Avec le terminal, GitHub, Supabase, etc. activés, les consignes et la description des outils pèsent plusieurs
 * milliers de tokens avant même ton message. Avec une limite de 3 000 à 6 000, LibreChat répond
 * « the agent's instructions and tool definitions already exceed the context budget ».
 * Cette valeur n'est qu'un plafond : on n'envoie au modèle que ce que la conversation contient vraiment.
 * Jamais bloquant : si une ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'maxContextTokens: 24000';

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-context-budget : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-context-budget : déjà appliqué');
  process.exit(0);
}

const edits = [
  ['Aube', '        model: "Aube"\n'],
  ['Soleil', '        model: "Soleil"\n'],
];

for (const [label, anchor] of edits) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.warn(`patch-context-budget : ancre « ${label} » trouvée ${count} fois (attendu : 1), ignoré`);
    process.exit(0);
  }
}

for (const [, anchor] of edits) {
  src = src.replace(anchor, () => `${anchor}        maxContextTokens: 24000\n`);
}

fs.writeFileSync(file, src);
console.log('patch-context-budget : appliqué');
