/**
 * Supabase MCP : moins d'outils exposés, donc moins de tokens à chaque appel.
 * Le serveur officiel accepte le paramètre d'adresse « features » (groupes d'outils : account, docs, database,
 * debugging, development, functions, storage, branching). Par défaut il expose tout sauf storage ; ici on garde
 * account (lister et réveiller les projets), database, development, docs et functions, et on retire branching
 * (6 outils de branches de développement) et debugging (journaux et conseils). Pour les remettre : ajouter le groupe
 * dans la liste, par exemple features=account,database,development,docs,functions,debugging.
 * Après ce changement, la première connexion à Supabase peut être redemandée (l'adresse du serveur change).
 * Jamais bloquant : si l'ancre est introuvable, librechat.yaml reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = 'mcp.supabase.com/mcp?features=';
const anchor = '    url: https://mcp.supabase.com/mcp\n';
const replacement = '    url: https://mcp.supabase.com/mcp?features=account,database,development,docs,functions\n';

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-supabase-features : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-supabase-features : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-supabase-features : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => replacement));
console.log('patch-supabase-features : appliqué');
