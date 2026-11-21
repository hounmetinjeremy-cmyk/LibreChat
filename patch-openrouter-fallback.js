/**
 * OpenRouter en secours automatique + pause des fournisseurs saturés (api/server/routes/aiModels.js).
 *
 * Problème : quand les autres fournisseurs (DeepSeek, Gemini, Cloudflare) refusent (limite de débit 429,
 * solde épuisé 402…), le serveur n'essayait jamais OpenRouter, même avec du crédit dessus : OpenRouter
 * n'était utilisé que s'il était choisi comme fournisseur préféré d'un rôle.
 *
 * Ce patch ajoute, sans rien changer tant que les variables ne sont pas posées :
 * - OPENROUTER_FALLBACK=on : OpenRouter devient le DERNIER secours automatique (jamais en premier),
 *   avec un modèle économique (par défaut google/gemini-2.5-flash) et non le Claude coûteux de AUTO_MODELS.
 *   Modèles réglables : OPENROUTER_FALLBACK_MODEL_AUBE et OPENROUTER_FALLBACK_MODEL_SOLEIL.
 * - PROVIDER_COOLDOWN_SECONDS=60 : un fournisseur qui vient de répondre 429 ou 402 est sauté pendant ce
 *   délai (par modèle), au lieu d'être réessayé à chaque étape. Le dernier candidat n'est jamais sauté.
 *
 * Idempotent et jamais bloquant : si une ancre est introuvable, le fichier reste tel quel (avertissement).
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const MARK = 'openrouterFallbackOn';

if (!fs.existsSync(file)) {
  console.warn('patch-openrouter-fallback : ' + file + ' introuvable, ignoré');
  process.exit(0);
}

const src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log('patch-openrouter-fallback : déjà appliqué');
  process.exit(0);
}

const edits = [
  {
    name: 'aides',
    from: "const OPT_IN_PROVIDERS = new Set(['openrouter']);",
    to: [
      "const OPT_IN_PROVIDERS = new Set(['openrouter']);",
      "/** OPENROUTER_FALLBACK=on : OpenRouter sert aussi de DERNIER secours automatique (jamais en premier). */",
      "const openrouterFallbackOn = () => String(process.env.OPENROUTER_FALLBACK || '').toLowerCase() === 'on';",
      "/** Modèles économiques utilisés quand OpenRouter sert de secours (réglables : OPENROUTER_FALLBACK_MODEL_AUBE / _SOLEIL). */",
      "const OPENROUTER_FALLBACK_DEFAULTS = { aube: 'google/gemini-2.5-flash', soleil: 'google/gemini-2.5-flash' };",
      "/** Pause d'un fournisseur saturé (429) ou sans solde (402) : sauté pendant PROVIDER_COOLDOWN_SECONDS. 0 = désactivé. */",
      'const cooldowns = new Map();',
      'const cooldownMs = () => {',
      "  const s = Number(process.env.PROVIDER_COOLDOWN_SECONDS ?? '0');",
      '  return Number.isFinite(s) && s > 0 ? s * 1000 : 0;',
      '};',
      'const inCooldown = (key) => (cooldowns.get(key) || 0) > Date.now();',
      'const markCooldown = (key) => {',
      '  const ms = cooldownMs();',
      '  if (ms > 0) {',
      '    cooldowns.set(key, Date.now() + ms);',
      '  }',
      '};',
    ].join('\n'),
  },
  {
    name: 'liste des candidats',
    from: '    if (OPT_IN_PROVIDERS.has(provider) && provider !== preferred) {',
    to: '    if (OPT_IN_PROVIDERS.has(provider) && provider !== preferred && !openrouterFallbackOn()) {',
  },
  {
    name: 'modèle de secours',
    from: '  return AUTO_MODELS[role][provider];\n',
    to: [
      "  if (provider === 'openrouter' && provider !== preferredProvider(cfg, role)) {",
      '    // Secours : modèle économique (le Claude de AUTO_MODELS coûterait bien plus cher).',
      "    const wanted = process.env['OPENROUTER_FALLBACK_MODEL_' + role.toUpperCase()];",
      '    return modelFits(provider, wanted) ? wanted : OPENROUTER_FALLBACK_DEFAULTS[role];',
      '  }',
      '  return AUTO_MODELS[role][provider];',
      '',
    ].join('\n'),
  },
  {
    name: 'début de boucle',
    from: [
      '    for (let i = 0; i < candidates.length; i++) {',
      '      const c = candidates[i];',
      '      const isLast = i === candidates.length - 1;',
    ].join('\n'),
    to: [
      '    for (let i = 0; i < candidates.length; i++) {',
      '      const c = candidates[i];',
      '      const isLast = i === candidates.length - 1;',
      "      if (!isLast && inCooldown(c.provider + '|' + c.model)) {",
      "        failures.push(PROVIDER_LABELS[c.provider] + ' en pause');",
      '        continue;',
      '      }',
    ].join('\n'),
  },
  {
    name: 'enregistrement des échecs',
    from: [
      '      if (!up.ok) {',
      '        failures.push(`${PROVIDER_LABELS[c.provider]} ${up.status}`);',
      '      }',
    ].join('\n'),
    to: [
      '      if (!up.ok) {',
      '        failures.push(`${PROVIDER_LABELS[c.provider]} ${up.status}`);',
      '      }',
      '      if (!up.ok && (up.status === 429 || up.status === 402)) {',
      "        markCooldown(c.provider + '|' + c.model);",
      '      }',
    ].join('\n'),
  },
];

let out = src;
for (const edit of edits) {
  const count = out.split(edit.from).length - 1;
  if (count !== 1) {
    console.warn(
      'patch-openrouter-fallback : ancre « ' + edit.name + ' » trouvée ' + count + ' fois (1 attendue), patch ignoré',
    );
    process.exit(0);
  }
  out = out.replace(edit.from, () => edit.to);
}

fs.writeFileSync(file, out);
console.log('patch-openrouter-fallback : appliqué (' + edits.length + ' modifications)');
