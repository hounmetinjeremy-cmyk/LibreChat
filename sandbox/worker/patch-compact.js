/**
 * Allège l'historique renvoyé au modèle à chaque étape (sandbox/worker/run.js).
 * Avant : seules les sorties d'outils anciennes étaient raccourcies ; le contenu complet de chaque
 * fichier écrit (write_file) restait dans l'historique et était renvoyé à chaque étape.
 * Après : tout ce qui est plus ancien que les 6 derniers messages est réduit à quelques mots
 * (sorties d'outils, contenus de fichiers écrits, rapports de vérification). Les 2 premiers
 * messages (consigne et tâche) et les 6 derniers restent complets.
 * Aucun message n'est supprimé : les appels d'outils et leurs résultats restent appariés.
 * Si l'ancre est introuvable, le build échoue (l'ancienne image reste en service).
 */
const fs = require('fs');

const file = 'run.js';
let src = fs.readFileSync(file, 'utf8');

if (src.includes('const KEEP_FULL')) {
  console.log('patch-compact : déjà appliqué');
  process.exit(0);
}

const re = /const compact = [^\n]*\n/;
if (!re.test(src)) {
  console.error('patch-compact : ancre introuvable dans run.js');
  process.exit(1);
}

const replacement = [
  'const KEEP_FULL = 6;',
  'const shrinkArgs = (c) => {',
  '  const a = (c.function && c.function.arguments) || "";',
  '  if (a.length <= 300) return c;',
  '  let stub = "{}";',
  '  try {',
  '    const o = JSON.parse(a);',
  '    for (const k of Object.keys(o)) {',
  '      if (typeof o[k] === "string" && o[k].length > 200) o[k] = "[" + o[k].length + " caractères]";',
  '    }',
  '    stub = JSON.stringify(o);',
  '  } catch {}',
  '  return { ...c, function: { ...c.function, arguments: stub } };',
  '};',
  'const compact = (m) =>',
  '  m.map((x, i) => {',
  '    if (i < 2 || i >= m.length - KEEP_FULL) return x;',
  '    const text = typeof x.content === "string" ? x.content : "";',
  '    if (x.role === "tool" && text.length > 200) return { ...x, content: text.slice(0, 200) + " [...]" };',
  '    if (x.role === "user" && text.length > 400) return { ...x, content: text.slice(0, 400) + " [...]" };',
  '    if (x.role === "assistant" && Array.isArray(x.tool_calls)) return { ...x, tool_calls: x.tool_calls.map(shrinkArgs) };',
  '    return x;',
  '  });',
  '',
].join('\n');

src = src.replace(re, () => replacement);
fs.writeFileSync(file, src);
console.log('patch-compact : appliqué');
