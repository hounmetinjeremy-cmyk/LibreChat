/**
 * Branche le détecteur anti-patinage (api/server/routes/loopGuard.js) et l'expert d'appoint (expertHelp.js) dans le
 * proxy /ai-proxy, juste après la conversion des messages. Actif par défaut ; LOOP_GUARD=off le désactive et
 * EXPERT_HELP=off désactive seulement l'expert, sans redéployer le code.
 * Jamais bloquant : si l'ancre est introuvable, aiModels.js reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = "require('./loopGuard')";
const anchor = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';
const block = [
  '    // Anti-patinage (patch-loop-guard.js) : 3 fois le même outil sans avancer -> un expert d\'appoint donne des instructions',
  '    // (expertHelp.js) ; sans expert, l\'outil est retiré et la consigne dit de changer de méthode.',
  '    try {',
  "      const guarded = await require('./loopGuard').run(body, (hit, messages) =>",
  "        require('./expertHelp').consult({",
  '          hit,',
  '          messages,',
  "          key: poolKey(cfg, 'openrouter'),",
  "          url: providerUrl(cfg, 'openrouter'),",
  '        }),',
  '      );',
  '      if (guarded) {',
  '        logger.warn(`[loopGuard] « ${guarded.name} » : ${guarded.reason}${guarded.advised ? \' (conseil de l\\\'expert ajouté)\' : \' (outil retiré)\'}`);',
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
if (!fs.existsSync('api/server/routes/loopGuard.js') || !fs.existsSync('api/server/routes/expertHelp.js')) {
  console.warn('patch-loop-guard : loopGuard.js ou expertHelp.js absent, ignoré');
  process.exit(0);
}
const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-loop-guard : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}
fs.writeFileSync(file, src.replace(anchor, () => anchor + block));
console.log('patch-loop-guard : appliqué');
