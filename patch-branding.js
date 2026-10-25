// Patch de build : remplace les logos (application, favicons, icône DeepSeek) par le logo
// de branding/. Si le dossier des images est introuvable, le patch est ignoré.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'client', 'public', 'assets');
if (!fs.existsSync(dir)) {
  console.warn('[patch-branding] dossier assets introuvable, patch ignoré');
  process.exit(0);
}

const read = (name) =>
  Buffer.from(fs.readFileSync(path.join(__dirname, 'branding', name), 'utf8').trim(), 'base64');
const logo = read('logo-256.png.b64');

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
  'viewBox="0 0 256 256" width="256" height="256">' +
  '<image width="256" height="256" xlink:href="data:image/png;base64,' +
  logo.toString('base64') +
  '"/></svg>\n';

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
console.log('[patch-branding] appliqué (' + Object.keys(targets).length + ' fichiers)');
