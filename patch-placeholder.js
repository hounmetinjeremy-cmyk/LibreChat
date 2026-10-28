/**
 * Texte du champ de saisie (comme dans Claude) :
 * - conversation vide  : « Discuter avec Jérémy… »
 * - après un échange   : « Répondre à Jérémy… »
 * Remplace l'ancien texte « Message Aube » dans client/src/hooks/Input/useTextarea.ts.
 * Patch idempotent ; si le point d'insertion est introuvable, il est ignoré (avertissement).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'client', 'src', 'hooks', 'Input', 'useTextarea.ts');

if (!fs.existsSync(file)) {
  console.warn('[patch-placeholder] useTextarea.ts introuvable, patch ignoré');
} else {
  const src = fs.readFileSync(file, 'utf8');
  const re =
    /return `\$\{localize\('com_endpoint_message_new',\s*\{\s*0:\s*sender \? sender : localize\('com_endpoint_ai'\),?\s*\}\)\}`;/;
  if (src.includes('Discuter avec Jérémy')) {
    console.log('[patch-placeholder] déjà appliqué');
  } else if (!re.test(src)) {
    console.warn('[patch-placeholder] point d\u2019insertion introuvable, patch ignoré');
  } else {
    const out = src.replace(
      re,
      () => "return latestMessage ? 'Répondre à Jérémy…' : 'Discuter avec Jérémy…';",
    );
    fs.writeFileSync(file, out);
    console.log('[patch-placeholder] appliqué');
  }
}
