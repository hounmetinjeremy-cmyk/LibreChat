/**
 * Bouton « Jérémy Code » (connexion GitHub en un appui) :
 *  - route /api/sandbox-job/github-connect : donne à l'utilisateur connecté son lien de connexion signé ;
 *  - tiroir mobile (Header.tsx) : une ligne « Jérémy Code » sous la liste des panneaux ;
 *  - barre latérale étroite (ExpandedPanel.tsx) : une icône « Jérémy Code » ;
 *  - messages du chat (MarkdownComponents.tsx) : le lien de connexion donné par l'IA devient un vrai bouton ;
 *  - librechat.yaml : le serveur « connexion-github » disparaît du menu + (chatMenu: false).
 * Jamais bloquant : si une ancre est introuvable, le fichier concerné est ignoré avec un avertissement.
 */
const fs = require('fs');

function patchFile(file, marker, steps) {
  try {
    let src = fs.readFileSync(file, 'utf8');
    if (marker.test(src)) {
      console.log('patch-jeremy-code : déjà appliqué (' + file + ')');
      return;
    }
    for (const [from] of steps) {
      const ok = typeof from === 'string' ? src.includes(from) : from.test(src);
      if (!ok) {
        console.warn('patch-jeremy-code : ancre introuvable, ignoré (' + file + ')');
        return;
      }
    }
    for (const [from, to] of steps) {
      src = src.replace(from, () => to(src.match(from)));
    }
    fs.writeFileSync(file, src);
    console.log('patch-jeremy-code : appliqué (' + file + ')');
  } catch (err) {
    console.warn('patch-jeremy-code : ignoré (' + file + ') : ' + (err && err.message));
  }
}

const importLine = "import JeremyCodeButton from '~/components/Nav/JeremyCodeButton';";
const cnImport = "import { cn } from '~/utils';";

/* 1. Route serveur : lien de connexion signé pour l'utilisateur connecté */
const route = [
  'const router = express.Router();',
  '',
  "/** Bouton Jérémy Code : lien de connexion GitHub signé (30 min) pour l'utilisateur connecté. */",
  "router.get('/github-connect', requireJwtAuth, (req, res) => {",
  "  const secret = process.env.ORCHESTRATOR_SECRET || '';",
  "  const userId = String((req.user && (req.user.id || req.user._id)) || '');",
  '  if (!secret || !/^[A-Za-z0-9_-]{8,64}$/.test(userId)) {',
  "    return res.status(503).json({ error: 'connexion indisponible' });",
  '  }',
  '  const exp = Date.now() + 30 * 60000;',
  "  const s = require('crypto').createHmac('sha256', secret).update(`${userId}.${exp}`).digest('hex');",
  '  return res',
  "    .set('Cache-Control', 'no-store')",
  '    .json({ url: `/api/github-link/start?u=${encodeURIComponent(userId)}&e=${exp}&s=${s}` });',
  '});',
].join('\n');

patchFile('api/server/routes/sandboxJob.js', /github-connect/, [
  ['const router = express.Router();', () => route],
]);

/* 2. Tiroir mobile */
patchFile('client/src/components/UnifiedSidebar/mobile/Header.tsx', /JeremyCodeButton/, [
  [cnImport, () => cnImport + '\n' + importLine],
  [
    '{links.length > PRIMARY_LINKS && (',
    () => '<JeremyCodeButton variant="row" onDone={onClose} />\n        {links.length > PRIMARY_LINKS && (',
  ],
]);

/* 3. Barre latérale étroite */
patchFile('client/src/components/UnifiedSidebar/ExpandedPanel.tsx', /JeremyCodeButton/, [
  [cnImport, () => cnImport + '\n' + importLine],
  [
    '<AgentMarketplaceButton />',
    () => '<AgentMarketplaceButton />\n      <JeremyCodeButton variant="icon" />',
  ],
]);

/* 4. Messages : le lien de connexion GitHub devient un vrai bouton */
patchFile('client/src/components/Chat/Messages/Content/MarkdownComponents.tsx', /JeremyCodeButton/, [
  ["import store from '~/store';", () => "import store from '~/store';\n" + importLine],
  [
    /const props: \{ target\?: string; onClick\?: React\.MouseEventHandler \} = \{ target: '_blank' \};/,
    (m) =>
      m[0] +
      "\n\n  if (typeof href === 'string' && href.includes('/api/github-link/start')) {\n    return <JeremyCodeButton variant=\"inline\" href={href} />;\n  }",
  ],
]);

/* 5. Le serveur MCP « connexion-github » quitte le menu + */
patchFile('librechat.yaml', /connexion-github:\n\s+chatMenu: false/, [
  [/\n  connexion-github:\n/, () => '\n  connexion-github:\n    chatMenu: false\n'],
]);
