/**
 * Relève la limite d'étapes par message (endpoints.agents.recursionLimit / maxRecursionLimit)
 * pour qu'une longue tâche (clone, édition, tests, push) ne s'arrête plus au milieu : une reprise
 * renvoie tout l'historique au modèle et coûte des tokens pour rien.
 * Valeur : variable d'environnement RECURSION_LIMIT (400 par défaut).
 * Nommé « zz » pour s'exécuter APRÈS patch-token-guards.js, qui cherche la ligne
 * « maxRecursionLimit: 100 » dans librechat.yaml : la modifier avant ferait ignorer ce patch.
 * Jamais bloquant : si une clé est introuvable, le fichier reste tel quel (avertissement).
 * Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const raw = Number(process.env.RECURSION_LIMIT || '400');
const limit = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 400;

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-zz-recursion : librechat.yaml illisible, ignoré');
  process.exit(0);
}

const keys = ['recursionLimit', 'maxRecursionLimit'];
for (const key of keys) {
  const re = new RegExp('^(\\s*' + key + ':\\s*)\\d+', 'gm');
  const found = src.match(re) || [];
  if (found.length !== 1) {
    console.warn(`patch-zz-recursion : « ${key} » trouvée ${found.length} fois (attendu : 1), ignoré`);
    process.exit(0);
  }
}

let out = src;
for (const key of keys) {
  const re = new RegExp('^(\\s*' + key + ':\\s*)\\d+', 'gm');
  out = out.replace(re, (_m, head) => head + limit);
}

if (out === src) {
  console.log('patch-zz-recursion : déjà appliqué');
  process.exit(0);
}

fs.writeFileSync(file, out);
console.log(`patch-zz-recursion : limite portée à ${limit} étapes`);
