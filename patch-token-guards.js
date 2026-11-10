/**
 * Garde-fous de tokens, avec les réglages que ta version de LibreChat accepte (vérifiés dans
 * packages/data-provider/src/config.ts, schéma agentsEndpointSchema et summarizationConfigSchema) :
 * - endpoints.agents.maxProviderErrorChars : 500 (2000 par défaut) : une erreur du fournisseur n'envoie plus un
 *   long pavé de texte au modèle ;
 * - summarization (clé de premier niveau) : résumé de conversation limité à 600 tokens (maxSummaryTokens),
 *   garde les 2 derniers échanges (retainRecent) et élague les anciennes sorties d'outils trop longues
 *   (contextPruning : les 6 dernières réponses de l'IA restent intactes ; seules les sorties de plus de 3000
 *   caractères sont touchées).
 * Cache de prompt : réécrire un ancien message change le début du prompt et fait perdre le cache à partir de ce
 * message. L'élagage ne démarre donc que sur de très longues conversations : sorties raccourcies à 70 % du budget
 * de contexte, effacées à 85 % (à 35 % et 60 %, il aurait joué presque à chaque étape, car les consignes et les
 * descriptions d'outils occupent déjà environ 28 000 tokens du budget).
 * Les capacités deferred_tools, execute_code et subagents sont déjà actives par défaut (defaultAgentCapabilities) :
 * rien à écrire, et écrire une liste de capacités remplacerait celle par défaut.
 * recursionLimit reste à 100 : une tâche terminal (clone, édition, tests, push) demande bien plus que 5 étapes.
 * Jamais bloquant : si l'ancre est introuvable ou si une des clés existe déjà, librechat.yaml reste tel quel
 * (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'librechat.yaml';
const marker = '# patch-token-guards';

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-token-guards : librechat.yaml illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-token-guards : déjà appliqué');
  process.exit(0);
}

const anchor = '    maxRecursionLimit: 100\n';
if (src.split(anchor).length - 1 !== 1 || /^summarization:/m.test(src) || /maxProviderErrorChars/.test(src)) {
  console.warn('patch-token-guards : ancre absente ou clé déjà présente, ignoré');
  process.exit(0);
}

src = src.replace(
  anchor,
  () =>
    anchor +
    '    # patch-token-guards : erreurs de fournisseur tronquées à 500 caractères dans le contexte\n' +
    '    maxProviderErrorChars: 500\n',
);
if (!src.endsWith('\n')) {
  src += '\n';
}
src += [
  '',
  "# patch-token-guards : résumé court et élagage des anciennes sorties d'outils (patch-token-guards.js)",
  'summarization:',
  '  enabled: true',
  '  maxSummaryTokens: 600',
  '  retainRecent:',
  '    turns: 2',
  '    tokens: 3000',
  '  contextPruning:',
  '    enabled: true',
  '    keepLastAssistants: 6',
  '    softTrimRatio: 0.7',
  '    hardClearRatio: 0.85',
  '    minPrunableToolChars: 3000',
  '',
].join('\n');

fs.writeFileSync(file, src);
console.log('patch-token-guards : appliqué');
