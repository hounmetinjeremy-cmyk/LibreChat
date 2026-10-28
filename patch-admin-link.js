/**
 * Ajoute un bouton « Clés API » dans l'en-tête du chat, à côté du sélecteur de modèle.
 * Visible uniquement pour le compte ADMIN (les clés serveur ne doivent pas être modifiables par les clients).
 * Il ouvre la page /admin-config. Patch idempotent ; si un point d'insertion est introuvable,
 * le patch est ignoré (avertissement) et le build continue.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'client', 'src', 'components', 'Chat', 'Header.tsx');
let src = fs.readFileSync(file, 'utf8');

const importAnchor = "import { useHasAccess } from '~/hooks';";
const hookAnchor = 'const { data: startupConfig } = useGetStartupConfig();';
const jsxAnchor = '{hasAccessToMultiConvo === true && (';

const once = (anchor) => src.split(anchor).length === 2;

if (src.includes('ADMIN_KEYS_LINK')) {
  console.log('[patch-admin-link] déjà appliqué');
} else if (!once(importAnchor) || !once(hookAnchor) || !once(jsxAnchor)) {
  console.warn('[patch-admin-link] point d\u2019insertion introuvable, patch ignoré');
} else {
  const jsx = [
    '{/* ADMIN_KEYS_LINK */}',
    "{user?.role === 'ADMIN' && (",
    '  <a',
    '    href="/admin-config"',
    '    aria-label="Clés API"',
    '    className="flex h-10 flex-shrink-0 items-center rounded-xl border border-border-light px-3 text-sm text-text-primary hover:bg-surface-hover"',
    '  >',
    '    Clés API',
    '  </a>',
    ')}',
    '        ' + jsxAnchor,
  ].join('\n        ');
  src = src.replace(importAnchor, () => "import { useHasAccess, useAuthContext } from '~/hooks';");
  src = src.replace(hookAnchor, () => hookAnchor + '\n  const { user } = useAuthContext();');
  src = src.replace(jsxAnchor, () => jsx);
  fs.writeFileSync(file, src);
  console.log('[patch-admin-link] appliqué');
}
