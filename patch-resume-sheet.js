// Patch de build : ajoute le bouton « Résumé » (fenêtre des étapes) sous chaque réponse
// qui contient des outils ou de la réflexion, et retire l'ancien affichage (lignes « Ran N actions »
// et « Pensées »). KEEP_OLD_ACTIVITY=1 garde l'ancien affichage. Si le point d'insertion est introuvable,
// le patch est ignoré (avertissement) et le build continue sans le bouton.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'client', 'src', 'components', 'Chat', 'Messages', 'Content', 'ContentParts.tsx');
const importLine = "import ResumeSheet, { hideActivity } from './Parts/ResumeSheet';\n";
const anchor = /<ContentPartsBody\s+\{\.\.\.props\}\s*\/>/g;
const keepOld = process.env.KEEP_OLD_ACTIVITY === '1';
const body = keepOld
  ? '<ContentPartsBody {...props} />\n'
  : '<ContentPartsBody\n' +
    '          {...props}\n' +
    '          content={hideActivity(props.content, props.attachments)}\n' +
    '        />\n';
const replacement =
  '<>\n' +
  '        ' + body +
  '        <ResumeSheet\n' +
  '          content={props.content}\n' +
  '          isSubmitting={props.isSubmitting}\n' +
  '          nested={props.nestedActivityPhase}\n' +
  '        />\n' +
  '      </>';

const source = fs.readFileSync(file, 'utf8');
const matches = source.match(anchor) || [];
if (source.includes('ResumeSheet')) {
  console.log('[patch-resume-sheet] déjà appliqué');
} else if (matches.length !== 1) {
  console.warn('[patch-resume-sheet] point d\'insertion introuvable, patch ignoré');
} else {
  fs.writeFileSync(file, importLine + source.replace(anchor, replacement));
  console.log('[patch-resume-sheet] appliqué');
}
