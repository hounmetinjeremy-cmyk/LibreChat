// Patch de build : met le nom « Jérémy » dans le code (titre, description, nom de l'application)
// et remplace les logos par branding/logo.png (ou logo.jpg) s'il est présent dans le dépôt.
// Ne fait jamais échouer la construction : tout problème est signalé par un avertissement.
const fs = require('fs');
const path = require('path');

const NAME = 'Jérémy';
const root = __dirname;
const log = (m) => console.log('[patch-branding] ' + m);
const warn = (m) => console.warn('[patch-branding] ' + m);

function replaceIn(rel, pairs) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    return warn(rel + ' introuvable, ignoré');
  }
  let src = fs.readFileSync(file, 'utf8');
  let n = 0;
  pairs.forEach(([from, to]) => {
    if (from.test(src)) {
      src = src.replace(from, to);
      n++;
    }
  });
  fs.writeFileSync(file, src);
  log(rel + ' : ' + n + ' remplacement(s)');
}

try {
  // 1. Le nom, directement dans le code
  replaceIn('client/index.html', [
    [/<title>LibreChat<\/title>/, '<title>' + NAME + '</title>'],
    [/content="LibreChat - [^"]*"/, 'content="' + NAME + '"'],
  ]);
  replaceIn('api/server/routes/config.js', [
    [/process\.env\.APP_TITLE\s*\|\|\s*'LibreChat'/g, "process.env.APP_TITLE || '" + NAME + "'"],
  ]);

  // 2. Le logo (si le fichier est dans le dépôt)
  const dir = path.join(root, 'client', 'public', 'assets');
  const candidates = ['logo.png', 'logo.jpg', 'logo.jpeg'].map((n) => path.join(root, 'branding', n));
  const logoFile = candidates.find((f) => fs.existsSync(f));
  if (!logoFile) {
    warn('branding/logo.png absent : logos non changés');
  } else if (!fs.existsSync(dir)) {
    warn('dossier assets introuvable : logos non changés');
  } else {
    const logo = fs.readFileSync(logoFile);
    const mime = logo[0] === 0xff && logo[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
      'viewBox="0 0 256 256" width="256" height="256">' +
      '<image width="256" height="256" xlink:href="data:' + mime + ';base64,' +
      logo.toString('base64') + '"/></svg>\n';
    const targets = {
      'logo.svg': svg,
      'deepseek.svg': svg,
      'favicon-16x16.png': logo,
      'favicon-32x32.png': logo,
      'apple-touch-icon-180x180.png': logo,
      'icon-192x192.png': logo,
      'maskable-icon.png': logo,
    };
    Object.keys(targets).forEach((name) => fs.writeFileSync(path.join(dir, name), targets[name]));
    log('logos remplacés (' + path.basename(logoFile) + ', ' + Object.keys(targets).length + ' fichiers)');
  }
} catch (e) {
  warn('erreur ignorée : ' + e.message);
}
