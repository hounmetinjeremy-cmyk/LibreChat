/**
 * Mode test « administrateur seul » : un interrupteur dans la page admin (/admin-config), carte « Accès à l'application ».
 * Coché : seul le compte ADMIN peut utiliser les modèles Aube et Soleil. Les autres utilisateurs reçoivent un message
 * « application en phase de test » et ne consomment aucun token (le refus part avant toute lecture d'image et tout
 * appel au fournisseur). Décoché : tout le monde peut utiliser l'application.
 * Le réglage est rangé avec la configuration des modèles (même base, même chiffrement, relu toutes les 15 secondes),
 * donc il survit aux redémarrages et reste synchronisé entre les machines.
 * Modifie api/server/routes/aiModels.js (refus + enregistrement) et api/server/adminConfig/admin-config.js (interrupteur).
 * Chaque fichier est modifié en entier ou pas du tout. Jamais bloquant : ancre introuvable = fichier laissé tel quel.
 * Idempotent.
 */
const fs = require('fs');

function patchFile(file, marker, steps, label) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`patch-admin-mode : ${label} illisible, ignoré`);
    return;
  }
  if (src.includes(marker)) {
    console.log(`patch-admin-mode : ${label} déjà appliqué`);
    return;
  }
  for (const [anchor] of steps) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.warn(`patch-admin-mode : ${label} : ancre trouvée ${count} fois (attendu : 1), ignoré`);
      return;
    }
  }
  for (const [anchor, replacement] of steps) {
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-admin-mode : ${label} appliqué`);
}

/* ---------- serveur : refus des non-administrateurs + enregistrement du réglage ---------- */

const gate = String.raw`    // Mode test (patch-admin-mode.js) : si l'administrateur l'a activé, seul le compte ADMIN utilise les modèles.
    if (cfg.adminOnly && String((req.headers && req.headers['x-user-role']) || '').toUpperCase() !== 'ADMIN') {
      return res
        .status(403)
        .json(err('Cette application est en phase de test : l’accès est réservé à l’administrateur pour le moment. Réessaie plus tard.'));
    }
`;

patchFile(
  'api/server/routes/aiModels.js',
  'cfg.adminOnly',
  [
    [
      '    const cfg = await loadConfig();\n    const candidates = candidatesFor(cfg, role);\n',
      '    const cfg = await loadConfig();\n' + gate + '    const candidates = candidatesFor(cfg, role);\n',
    ],
    [
      '    await saveConfig(cfg);\n',
      "    if (typeof body.adminOnly === 'boolean') {\n      cfg.adminOnly = body.adminOnly;\n    }\n    await saveConfig(cfg);\n",
    ],
    ['  out.vision = {\n', '  out.adminOnly = Boolean(cfg.adminOnly);\n  out.vision = {\n'],
  ],
  'aiModels.js',
);

/* ---------- page admin : carte « Accès à l'application » avec son interrupteur ---------- */

const buildAccess = String.raw`  /* Mode test : coché = seul l'administrateur peut utiliser l'application (enregistré tout de suite). */
  function buildAccess() {
    var box = el('input', { type: 'checkbox', id: 'adminOnly' });
    box.style.width = 'auto';
    box.style.margin = '0 8px 0 0';
    var state = el('div', { className: 'state' });
    box.addEventListener('change', function () {
      var wanted = box.checked;
      box.disabled = true;
      setStatus('Enregistrement…');
      api('/api/admin-models', 'PUT', { adminOnly: wanted })
        .then(function (d) {
          renderModels(d);
          setStatus(wanted ? 'Mode test activé : seul l’administrateur peut utiliser l’application.' : 'Mode test désactivé : tous les utilisateurs peuvent utiliser l’application.', 'ok');
        })
        .catch(function (e) { box.checked = !wanted; setStatus(e.message, 'err'); })
        .then(function () { box.disabled = false; });
    });
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Accès à l’application' }),
      el('div', { className: 'help', textContent: 'Coché : seul ton compte administrateur peut envoyer des messages. Les autres utilisateurs voient un message « application en phase de test » et ne consomment aucun token. Décoché : tout le monde peut utiliser l’application.' }),
      el('div', { className: 'field' }, [box, el('label', { htmlFor: 'adminOnly', textContent: 'Réservé à l’administrateur (mode test)' })]),
      state
    ]));
    refs.access = { box: box, state: state };
  }

`;

const showAccess = String.raw`    if (refs.access) {
      refs.access.box.checked = Boolean(data.adminOnly);
      refs.access.state.textContent = data.adminOnly ? 'Actuellement : réservé à l’administrateur.' : 'Actuellement : ouvert à tous les utilisateurs.';
      refs.access.state.className = data.adminOnly ? 'state ok' : 'state';
    }
`;

patchFile(
  'api/server/adminConfig/admin-config.js',
  'buildAccess',
  [
    ['        buildKeys();\n        buildLive();\n', '        buildAccess();\n        buildKeys();\n        buildLive();\n'],
    ['  function buildVideo() {\n', buildAccess + '  function buildVideo() {\n'],
    [
      "    var v = data.vision || {};\n    refs.vision.model.value = v.model || '';\n",
      "    var v = data.vision || {};\n    refs.vision.model.value = v.model || '';\n" + showAccess,
    ],
  ],
  'admin-config.js',
);
