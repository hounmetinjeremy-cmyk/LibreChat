/**
 * Quota de tokens par jour et par utilisateur (3 000 000, réglé dans l'orchestrateur : TOKENS_PER_USER_DAY).
 * Depuis le moteur unique, c'est l'IA du chat qui travaille : on compte donc ses tokens ici, au passage de la
 * route interne /ai-proxy (api/server/routes/aiModels.js), et on les envoie à l'orchestrateur (POST /usage).
 * - avant chaque message : si le quota du jour est épuisé, le chat répond 429 ;
 * - après chaque réponse : tokens du fournisseur (sans la partie déjà en cache), sinon estimation ;
 * - librechat.yaml : l'identifiant de l'utilisateur est envoyé dans l'en-tête X-User-Id à /ai-proxy ;
 * - sandboxJob.js : l'écran « Tokens » affiche le plafond renvoyé par l'orchestrateur.
 * Jamais bloquant : si une ancre est introuvable, le fichier concerné est ignoré (avertissement) et le build
 * continue. Si l'orchestrateur ne répond pas, le chat n'est jamais bloqué. Idempotent.
 */
const fs = require('fs');
const path = require('path');

function patchFile(file, marker, edits) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`patch-token-quota : ${file} illisible, ignoré`);
    return;
  }
  if (src.includes(marker)) {
    console.log(`patch-token-quota : ${file} déjà appliqué`);
    return;
  }
  for (const [label, anchor, replacement] of edits) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.warn(
        `patch-token-quota : ancre « ${label} » trouvée ${count} fois dans ${file} (attendu : 1), fichier ignoré`,
      );
      return;
    }
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-token-quota : ${file} appliqué`);
}

const helpers = fs.readFileSync(path.join(__dirname, 'patch-token-quota.snippet'), 'utf8');

/* ---------- route interne : api/server/routes/aiModels.js ---------- */

const RUN_LINE = "const run = (fn) => (typeof runAsSystem === 'function' ? runAsSystem(fn) : fn());";
const CONVERT_LINE = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';
const GEMINI_COMMENT = '      // Gemini : une limite de sortie trop basse peut couper ou vider la réponse.\n';
const PIPE_BLOCK = [
  '    Readable.fromWeb(up.body)',
  "      .on('error', () => res.end())",
  '      .pipe(res);',
  '',
].join('\n');

const QUOTA_CHECK = [
  '    const quotaUser = quotaUserOf(req);',
  '    if (quotaUser) {',
  '      const left = await quotaLeft(quotaUser);',
  '      if (left !== null && left <= 0) {',
  "        return res.status(429).json(err('Ton quota de tokens du jour est épuisé. Il se renouvelle demain.'));",
  '      }',
  '    }',
  '',
].join('\n');

const STREAM_OPTIONS = [
  "      // Compteur de tokens : le fournisseur envoie l'usage à la fin du flux (sauf Cloudflare).",
  "      if (payload.stream && c.provider !== 'cloudflare') {",
  '        payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };',
  '      }',
  '',
].join('\n');

const METERED_PIPE = [
  '    const metered = Readable.fromWeb(up.body);',
  '    if (quotaUser) {',
  "      meterStream(metered, Boolean(body.stream), JSON.stringify(body.messages || '').length, quotaUser);",
  '    }',
  "    metered.on('error', () => res.end()).pipe(res);",
  '',
].join('\n');

patchFile('api/server/routes/aiModels.js', 'quotaLeft', [
  ['aides', RUN_LINE, `${RUN_LINE}\n\n${helpers}`],
  ['contrôle du quota', CONVERT_LINE, CONVERT_LINE + QUOTA_CHECK],
  ['usage du flux', GEMINI_COMMENT, STREAM_OPTIONS + GEMINI_COMMENT],
  ['comptage de la réponse', PIPE_BLOCK, METERED_PIPE],
]);

/* ---------- écran « Tokens » : api/server/routes/sandboxJob.js ---------- */

patchFile('api/server/routes/sandboxJob.js', 'tokens_max_jour', [
  [
    'plafond par défaut',
    'const dailyLimit = () => Number(process.env.SANDBOX_DAILY_TOKENS) || 2000000;',
    'const dailyLimit = () => Number(process.env.SANDBOX_DAILY_TOKENS) || 3000000;',
  ],
  [
    'plafond renvoyé',
    '    const limit = Math.max(dailyLimit(), remaining);\n',
    '    const limit = Math.max(Number(q.tokens_max_jour) || dailyLimit(), remaining);\n',
  ],
]);

/* ---------- librechat.yaml : identifiant de l'utilisateur envoyé à /ai-proxy ---------- */

patchFile('librechat.yaml', '# quota-tokens', [
  [
    'en-tête utilisateur',
    '      baseURL: "http://127.0.0.1:3080/ai-proxy/v1"\n',
    [
      '      baseURL: "http://127.0.0.1:3080/ai-proxy/v1"',
      "      # quota-tokens : l'identifiant de l'utilisateur sert à compter ses tokens du jour (patch-token-quota.js)",
      '      headers:',
      '        X-User-Id: "{{LIBRECHAT_USER_ID}}"',
      '',
    ].join('\n'),
  ],
]);
