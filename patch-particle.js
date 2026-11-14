/**
 * Moteur Particle AI (OpenRouter) avec bascule automatique gratuit -> payant -> chaîne habituelle.
 * La logique est dans api/server/routes/particleRoute.js ; ce patch la branche dans le proxy (aiModels.js) :
 *  - candidatesFor : les essais Particle sont placés devant la chaîne existante ;
 *  - requête : le routage Relace imposé n'est pas envoyé pour ces essais (il est réservé aux modèles DeepSeek) ;
 *  - échec d'un essai : le gratuit est mis de côté quelques minutes.
 * Inactif tant que PARTICLE_AI=on n'est pas défini (secret Fly). S'applique après patch-openrouter.js (ordre
 * alphabétique du build). Idempotent, jamais bloquant : si une ancre est introuvable, rien n'est modifié.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = "require('./particleRoute')";

const edits = [
  [
    'chaîne',
    '  return out;\n}\n\nfunction resolveVision(cfg) {',
    [
      "  return require('./particleRoute')",
      "    .front(role, poolKey(cfg, 'openrouter'), providerUrl(cfg, 'openrouter'))",
      '    .concat(out);',
      '}',
      '',
      'function resolveVision(cfg) {',
    ].join('\n'),
  ],
  [
    'routage',
    "      if (c.provider === 'openrouter') {\n        payload.provider = OPENROUTER_ROUTING;\n      }\n",
    "      if (c.provider === 'openrouter' && !c.noRouting) {\n        payload.provider = OPENROUTER_ROUTING;\n      }\n",
  ],
  [
    'échec',
    '      if (!up.ok) {\n        failures.push(`${PROVIDER_LABELS[c.provider]} ${up.status}`);\n',
    "      if (!up.ok) {\n        require('./particleRoute').noteFailure(c, up.status);\n        failures.push(`${PROVIDER_LABELS[c.provider]} ${up.status}`);\n",
  ],
];

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-particle : aiModels.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-particle : déjà appliqué');
  process.exit(0);
}
if (!fs.existsSync('api/server/routes/particleRoute.js')) {
  console.warn('patch-particle : particleRoute.js absent, ignoré');
  process.exit(0);
}
for (const [label, anchor] of edits) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.warn(`patch-particle : ancre « ${label} » trouvée ${count} fois (attendu : 1), ignoré`);
    process.exit(0);
  }
}
for (const [, anchor, replacement] of edits) {
  src = src.replace(anchor, () => replacement);
}
fs.writeFileSync(file, src);
console.log('patch-particle : appliqué');
