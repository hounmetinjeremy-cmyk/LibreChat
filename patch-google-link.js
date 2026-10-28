/**
 * Permet aux anciens comptes créés avec le formulaire (email + mot de passe) de se connecter
 * avec le bouton « Continuer avec Google » quand l'email Google est vérifié et identique.
 * Le compte garde son mot de passe : les deux méthodes fonctionnent.
 * Patch idempotent ; échoue volontairement si l'ancre est introuvable.
 */
const fs = require('fs');

const file = 'api/strategies/socialLogin.js';
const src = fs.readFileSync(file, 'utf8');
const anchor = 'if (existingUser?.provider === provider) {';

if (src.includes('GOOGLE_LINK_PATCH')) {
  console.log('patch-google-link : déjà appliqué');
} else if (!src.includes(anchor)) {
  console.error('patch-google-link : ancre introuvable dans ' + file);
  process.exit(1);
} else {
  const addition = [
    '// GOOGLE_LINK_PATCH : relie un ancien compte local au compte Google (email vérifié)',
    "if (existingUser && existingUser.provider === 'local' && provider === 'google' && emailVerified) {",
    '  if (id && !existingUser[providerKey]) {',
    '    await updateUser(existingUser._id, { [providerKey]: id });',
    '  }',
    '  await handleExistingUser(existingUser, avatarUrl, appConfig, email);',
    '  return passResult(existingUser);',
    '}',
    '',
    '      ' + anchor,
  ].join('\n      ');
  fs.writeFileSync(file, src.replace(anchor, () => addition));
  console.log('patch-google-link : appliqué');
}
