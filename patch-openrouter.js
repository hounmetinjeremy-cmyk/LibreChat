/**
 * Ajoute OpenRouter (hébergeur Relace imposé) comme fournisseur d'Aube et de Soleil :
 * - api/server/routes/aiModels.js : URL, clé de secours OPENROUTER_API_KEY, modèle de repli, routage Relace ;
 * - api/server/adminConfig/admin-config.js : fournisseur, champ « Clé OpenRouter » dans « Clés API ».
 * Idempotent. Si une ancre est introuvable, le build échoue volontairement (l'ancienne version reste en ligne).
 */
const fs = require('fs');

function patchFile(file, marker, edits) {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(marker)) {
    console.log(`patch-openrouter : ${file} déjà appliqué`);
    return;
  }
  for (const [label, anchor, replacement] of edits) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.error(`patch-openrouter : ancre « ${label} » trouvée ${count} fois dans ${file} (attendu : 1)`);
      process.exit(1);
    }
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-openrouter : ${file} appliqué`);
}

/* ---------- serveur : api/server/routes/aiModels.js ---------- */

patchFile('api/server/routes/aiModels.js', "openrouter: 'https://openrouter.ai", [
  [
    'libellés',
    "const PROVIDER_LABELS = { deepseek: 'DeepSeek', gemini: 'Gemini', cloudflare: 'Cloudflare' };",
    "const PROVIDER_LABELS = {\n  deepseek: 'DeepSeek',\n  gemini: 'Gemini',\n  cloudflare: 'Cloudflare',\n  openrouter: 'OpenRouter',\n};\n" +
      "/** OpenRouter : hébergeur Relace imposé, sans repli chez OpenRouter (le repli se fait entre fournisseurs). */\n" +
      "const OPENROUTER_ROUTING = { order: ['Relace'], allow_fallbacks: false };",
  ],
  [
    'adresse',
    "  cloudflare: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions',\n",
    "  cloudflare: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/chat/completions',\n" +
      "  openrouter: 'https://openrouter.ai/api/v1/chat/completions',\n",
  ],
  [
    'modèle de repli Aube',
    "    cloudflare: '@cf/zai-org/glm-4.7-flash',\n",
    "    cloudflare: '@cf/zai-org/glm-4.7-flash',\n    openrouter: 'deepseek/deepseek-v4.1-flash-1017',\n",
  ],
  [
    'modèle de repli Soleil',
    "    cloudflare: '@cf/openai/gpt-oss-120b',\n",
    "    cloudflare: '@cf/openai/gpt-oss-120b',\n    openrouter: 'deepseek/deepseek-v4.1-flash-1017',\n",
  ],
  [
    'modelFits',
    String.raw`  return !/^gemini/i.test(model) && !/^@cf\//i.test(model);`,
    String.raw`  if (provider === 'openrouter') {` + '\n' +
      String.raw`    return model.includes('/') && !/^@(cf|hf)\//i.test(model);` + '\n' +
      '  }\n' +
      String.raw`  return !/^gemini/i.test(model) && !/^@cf\//i.test(model) && !model.includes('/');`,
  ],
  [
    'clés de secours',
    '    cloudflare: real(process.env.CLOUDFLARE_API_TOKEN),\n',
    '    cloudflare: real(process.env.CLOUDFLARE_API_TOKEN),\n    openrouter: real(process.env.OPENROUTER_API_KEY),\n',
  ],
  [
    'requête',
    '      const payload = { ...body, model: c.model };\n',
    '      const payload = { ...body, model: c.model };\n' +
      "      if (c.provider === 'openrouter') {\n" +
      '        payload.provider = OPENROUTER_ROUTING;\n' +
      '      }\n',
  ],
  [
    'liste des modèles',
    '  async cloudflare(cfg, key) {',
    '  async openrouter() {\n' +
      "    return ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash'];\n" +
      '  },\n' +
      '  async cloudflare(cfg, key) {',
  ],
]);

/* ---------- page admin : api/server/adminConfig/admin-config.js ---------- */

patchFile('api/server/adminConfig/admin-config.js', "id: 'openrouter'", [
  [
    'fournisseurs',
    "    { id: 'cloudflare', label: 'Cloudflare Workers AI' }\n  ];",
    "    { id: 'cloudflare', label: 'Cloudflare Workers AI' },\n    { id: 'openrouter', label: 'OpenRouter (Relace)' }\n  ];",
  ],
  [
    'libellés',
    "  var LABEL = { deepseek: 'DeepSeek', gemini: 'Gemini', cloudflare: 'Cloudflare' };",
    "  var LABEL = { deepseek: 'DeepSeek', gemini: 'Gemini', cloudflare: 'Cloudflare', openrouter: 'OpenRouter' };",
  ],
  [
    'modèles de secours',
    '  var MODELS = {\n',
    "  var MODELS = {\n    openrouter: ['deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash'],\n",
  ],
  [
    'champ clé',
    "    var account = keyField('cloudflare-account',",
    "    var openrouter = keyField('openrouter', 'Clé OpenRouter', 'Utilisée par Aube et Soleil quand OpenRouter est choisi (hébergeur Relace).', function () {\n" +
      "      return api('/api/admin-models', 'PUT', { keys: { openrouter: null } }).then(renderModels);\n" +
      '    });\n' +
      "    var account = keyField('cloudflare-account',",
  ],
  [
    'carte des clés',
    '      cloudflare.wrap,\n      account.wrap\n',
    '      cloudflare.wrap,\n      openrouter.wrap,\n      account.wrap\n',
  ],
  [
    'références',
    '    refs.keys = { deepseek: deepseek, gemini: gemini, cloudflare: cloudflare };',
    '    refs.keys = { deepseek: deepseek, gemini: gemini, cloudflare: cloudflare, openrouter: openrouter };',
  ],
  [
    'affichage',
    '    showState(refs.keys.cloudflare, keys.cloudflare);',
    '    showState(refs.keys.cloudflare, keys.cloudflare);\n    showState(refs.keys.openrouter, keys.openrouter);',
  ],
  [
    'enregistrement',
    "    ['deepseek', 'gemini', 'cloudflare'].forEach(function (p) {",
    "    ['deepseek', 'gemini', 'cloudflare', 'openrouter'].forEach(function (p) {",
  ],
]);
