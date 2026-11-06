/**
 * Connexion Cloudflare (déploiement sur Cloudflare Pages) :
 *  - route /api/cloudflare-link branchée dans api/server/index.js ;
 *  - bouton « Cloudflare » dans le tiroir mobile et la barre latérale, et bouton dans le chat quand l'IA
 *    donne le lien #cloudflare-connect (fenêtre de saisie du jeton avec lien de création prérempli) ;
 *  - librechat.yaml : consignes de l'IA (outil link_pages, bouton Connecter Cloudflare, jamais de jeton dans le chat).
 * Jamais bloquant : si une ancre est introuvable, le fichier concerné est ignoré avec un avertissement.
 */
const fs = require('fs');

function patchFile(file, marker, steps) {
  try {
    let src = fs.readFileSync(file, 'utf8');
    if (marker.test(src)) {
      console.log('patch-cloudflare-link : déjà appliqué (' + file + ')');
      return;
    }
    for (const [from] of steps) {
      const ok = typeof from === 'string' ? src.includes(from) : from.test(src);
      if (!ok) {
        console.warn('patch-cloudflare-link : ancre introuvable, ignoré (' + file + ')');
        return;
      }
    }
    for (const [from, to] of steps) {
      src = src.replace(from, () => to(src.match(from)));
    }
    fs.writeFileSync(file, src);
    console.log('patch-cloudflare-link : appliqué (' + file + ')');
  } catch (err) {
    console.warn('patch-cloudflare-link : ignoré (' + file + ') : ' + (err && err.message));
  }
}

/* 1. Route serveur */
const keysAnchor = "app.use('/api/keys', routes.keys);";
patchFile('api/server/index.js', /\.\/routes\/cloudflareLink/, [
  [
    keysAnchor,
    () => keysAnchor + "\n  app.use('/api/cloudflare-link', require('./routes/cloudflareLink'));",
  ],
]);

/* 2. Interface */
const jeremyImport = "import JeremyCodeButton from '~/components/Nav/JeremyCodeButton';";
const cfImport = "import CloudflareConnectButton from '~/components/Nav/CloudflareConnect';";
const addImport = [jeremyImport, () => jeremyImport + '\n' + cfImport];

patchFile('client/src/components/UnifiedSidebar/mobile/Header.tsx', /CloudflareConnectButton/, [
  addImport,
  [
    '<JeremyCodeButton variant="row" onDone={onClose} />',
    () =>
      '<JeremyCodeButton variant="row" onDone={onClose} />\n        <CloudflareConnectButton variant="row" />',
  ],
]);

patchFile('client/src/components/UnifiedSidebar/ExpandedPanel.tsx', /CloudflareConnectButton/, [
  addImport,
  [
    '<JeremyCodeButton variant="icon" />',
    () => '<JeremyCodeButton variant="icon" />\n      <CloudflareConnectButton variant="icon" />',
  ],
]);

patchFile('client/src/components/Chat/Messages/Content/MarkdownComponents.tsx', /CloudflareConnectButton/, [
  addImport,
  [
    "if (typeof href === 'string' && href.includes('/api/github-link/start')) {",
    () =>
      "if (typeof href === 'string' && href.includes('#cloudflare-connect')) {\n    return <CloudflareConnectButton variant=\"inline\" />;\n  }\n\n  if (typeof href === 'string' && href.includes('/api/github-link/start')) {",
  ],
]);

/* 3. Consignes de l'IA */
const extra = [
  'Après un projet créé ou modifié par run_task, propose en une phrase de le mettre en ligne sur Cloudflare Pages ; si l’utilisateur accepte ou l’a demandé, appelle link_pages avec le dépôt (propriétaire/nom) : chaque modification sera alors republiée automatiquement.',
  'Si un outil ou le résultat d’une tâche indique que Cloudflare n’est pas connecté, écris une phrase courte puis affiche exactement ce lien Markdown : [Connecter Cloudflare](#cloudflare-connect) ; l’utilisateur le touche et colle son jeton Cloudflare dans la fenêtre prévue, une seule fois, et c’est fini. Ne lui demande jamais le jeton dans le chat.',
].join(' ');

patchFile('librechat.yaml', /link_pages/, [
  [
    /serverInstructions: &sbxInstructions "([^\n]*)"/,
    (m) => 'serverInstructions: &sbxInstructions "' + m[1] + ' ' + extra + '"',
  ],
]);
