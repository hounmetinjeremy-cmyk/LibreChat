/**
 * Branche le détecteur anti-patinage (api/server/routes/loopGuard.js) dans le proxy /ai-proxy, juste après la
 * conversion des messages. Actif par défaut ; LOOP_GUARD=off le désactive sans redéployer le code.
 * Jamais bloquant : si l'ancre est introuvable, aiModels.js reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = "require('./loopGuard')";
const anchor = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';
const block = [
  '    // Anti-patinage (patch-loop-guard.js) : 3 fois le même outil sans avancer -> outil retiré, consigne au modèle.',
  '    try {',
  "      const guarded = require('./loopGuard').apply(body);",
  '      if (guarded) {',
  '        logger.warn(`[loopGuard] « ${guarded.name} » retiré : ${guarded.reason}`);',
  '      }',
  '    } catch (e) {',
  '      /* jamais bloquant */',
  '    }',
  '',
].join('\n');

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-loop-guard : aiModels.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-loop-guard : déjà appliqué');
  process.exit(0);
}
if (!fs.existsSync('api/server/routes/loopGuard.js')) {
  console.warn('patch-loop-guard : loopGuard.js absent, ignoré');
  process.exit(0);
}
const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-loop-guard : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}
fs.writeFileSync(file, src.replace(anchor, () => anchor + block));
console.log('patch-loop-guard : appliqué');
