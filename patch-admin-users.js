/**
 * Mode test : liste des utilisateurs (e-mail) dans la page admin (/admin-config), carte « Utilisateurs autorisés ».
 * Quand l'interrupteur « Réservé à l'administrateur » (patch-admin-mode.js) est coché, le compte ADMIN et les comptes
 * cochés dans cette liste peuvent utiliser Aube et Soleil ; tous les autres reçoivent le message « phase de test » et ne
 * consomment aucun token. La liste est rangée avec la configuration des modèles (même base, même chiffrement).
 * Modifie api/server/routes/aiModels.js (liste des comptes, refus, enregistrement) et api/server/adminConfig/admin-config.js
 * (carte avec une case par compte). Le serveur ne renvoie que l'identifiant, l'e-mail, le nom, le rôle et la date de création :
 * jamais de mot de passe ni de jeton.
 * Doit passer APRÈS patch-admin-mode.js (le Dockerfile applique les patchs dans l'ordre alphabétique : admin-mode, puis admin-users).
 * Chaque fichier est modifié en entier ou pas du tout. Jamais bloquant : ancre introuvable = fichier laissé tel quel. Idempotent.
 */
const fs = require('fs');

function patchFile(file, marker, steps, label) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`patch-admin-users : ${label} illisible, ignoré`);
    return;
  }
  if (src.includes(marker)) {
    console.log(`patch-admin-users : ${label} déjà appliqué`);
    return;
  }
  for (const [anchor] of steps) {
    const count = src.split(anchor).length - 1;
    if (count !== 1) {
      console.warn(`patch-admin-users : ${label} : ancre trouvée ${count} fois (attendu : 1), ignoré (patch-admin-mode.js appliqué avant ?)`);
      return;
    }
  }
  for (const [anchor, replacement] of steps) {
    src = src.replace(anchor, () => replacement);
  }
  fs.writeFileSync(file, src);
  console.log(`patch-admin-users : ${label} appliqué`);
}

/* ---------- serveur ---------- */

const gateOld = String.raw`    if (cfg.adminOnly && String((req.headers && req.headers['x-user-role']) || '').toUpperCase() !== 'ADMIN') {
`;
const gateNew = String.raw`    if (
      cfg.adminOnly &&
      String((req.headers && req.headers['x-user-role']) || '').toUpperCase() !== 'ADMIN' &&
      !(Array.isArray(cfg.allowedUsers) && cfg.allowedUsers.includes(String((req.headers && req.headers['x-user-id']) || '')))
    ) {
`;

const saveOld = "    if (typeof body.adminOnly === 'boolean') {\n      cfg.adminOnly = body.adminOnly;\n    }\n";
const saveNew =
  saveOld +
  String.raw`    if (Array.isArray(body.allowedUsers)) {
      cfg.allowedUsers = Array.from(new Set(body.allowedUsers.map(String).filter((u) => QUOTA_USER_RE.test(u)))).slice(0, 5000);
    }
`;

const routeAnchor = "adminRouter.put('/api/admin-models', requireJwtAuth, requireAdmin, async (req, res) => {\n";
const usersRoute = String.raw`/** Comptes de l'application (identifiant, e-mail, nom, rôle) pour choisir qui peut l'utiliser en mode test. Jamais de mot de passe. */
adminRouter.get('/api/admin-users', requireJwtAuth, requireAdmin, async (_req, res) => {
  try {
    const rows = await run(async () =>
      mongoose.connection
        .collection('users')
        .find({}, { projection: { email: 1, name: 1, username: 1, role: 1, provider: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(2000)
        .toArray(),
    );
    const users = rows.map((u) => ({
      id: String(u._id),
      email: u.email || '',
      name: u.name || u.username || '',
      role: u.role || 'USER',
      provider: u.provider || '',
      createdAt: u.createdAt || null,
    }));
    res.set('Cache-Control', 'no-store');
    return res.json({ users });
  } catch (e) {
    logger.error('[aiModels] liste des utilisateurs impossible', e);
    return res.status(500).json({ message: 'Liste des utilisateurs impossible' });
  }
});

`;

patchFile(
  'api/server/routes/aiModels.js',
  'cfg.allowedUsers',
  [
    [gateOld, gateNew],
    [saveOld, saveNew],
    ['  out.adminOnly = Boolean(cfg.adminOnly);\n', "  out.adminOnly = Boolean(cfg.adminOnly);\n  out.allowedUsers = Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers : [];\n"],
    [routeAnchor, usersRoute + routeAnchor],
  ],
  'aiModels.js',
);

/* ---------- page admin : carte « Utilisateurs autorisés » ---------- */

const buildUsers = String.raw`  /* Mode test : e-mail de chaque compte avec une case « autorisé ». Chaque case est enregistrée tout de suite. */
  function buildUsers() {
    var search = el('input', { type: 'text', placeholder: 'Rechercher un e-mail ou un nom…', autocomplete: 'off' });
    var info = el('div', { className: 'state' });
    var list = el('div', {});
    var reload = el('button', { type: 'button', textContent: 'Actualiser la liste' });
    refs.users = { all: [], allowed: {}, search: search, info: info, list: list };
    search.addEventListener('input', renderUsers);
    reload.addEventListener('click', loadUsers);
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Utilisateurs autorisés' }),
      el('div', { className: 'help', textContent: 'Quand « Réservé à l’administrateur » est coché, seuls ton compte et les comptes cochés ici peuvent utiliser l’application. Chaque case est enregistrée tout de suite.' }),
      el('div', { className: 'field' }, [search]),
      info, list, reload
    ]));
    loadUsers();
  }

  function loadUsers() {
    var u = refs.users;
    u.info.className = 'state';
    u.info.textContent = 'Chargement…';
    api('/api/admin-users', 'GET')
      .then(function (d) { u.all = d.users || []; renderUsers(); })
      .catch(function (e) { u.info.className = 'state err'; u.info.textContent = e.message; });
  }

  function renderUsers() {
    var u = refs.users;
    if (!u) { return; }
    var q = u.search.value.trim().toLowerCase();
    var shown = u.all.filter(function (x) {
      return !q || x.email.toLowerCase().indexOf(q) >= 0 || x.name.toLowerCase().indexOf(q) >= 0;
    });
    u.info.className = 'state';
    u.info.textContent = u.all.length + ' compte(s), ' + Object.keys(u.allowed).length + ' autorisé(s) en plus de l’administrateur.';
    u.list.textContent = '';
    shown.forEach(function (x) {
      var isAdmin = x.role === 'ADMIN';
      var box = el('input', { type: 'checkbox', id: 'user-' + x.id });
      box.style.width = 'auto';
      box.style.margin = '0 8px 0 0';
      box.checked = isAdmin || Boolean(u.allowed[x.id]);
      box.disabled = isAdmin;
      box.addEventListener('change', function () {
        var next = Object.keys(u.allowed);
        var i = next.indexOf(x.id);
        if (box.checked && i < 0) { next.push(x.id); }
        if (!box.checked && i >= 0) { next.splice(i, 1); }
        box.disabled = true;
        setStatus('Enregistrement…');
        api('/api/admin-models', 'PUT', { allowedUsers: next })
          .then(function (d) { renderModels(d); setStatus('Enregistré.', 'ok'); })
          .catch(function (e) { box.checked = !box.checked; setStatus(e.message, 'err'); })
          .then(function () { box.disabled = isAdmin; });
      });
      var label = el('label', { htmlFor: 'user-' + x.id, textContent: x.email + (x.name ? '  (' + x.name + ')' : '') + (isAdmin ? '  — administrateur' : '') });
      label.style.display = 'inline';
      u.list.appendChild(el('div', { className: 'field' }, [box, label]));
    });
  }

`;

const showUsers = String.raw`    if (refs.users) {
      refs.users.allowed = {};
      (data.allowedUsers || []).forEach(function (id) { refs.users.allowed[id] = true; });
      renderUsers();
    }
`;

const accessEnd = "      refs.access.state.className = data.adminOnly ? 'state ok' : 'state';\n    }\n";

patchFile(
  'api/server/adminConfig/admin-config.js',
  'buildUsers',
  [
    ['        buildAccess();\n', '        buildAccess();\n        buildUsers();\n'],
    ['  function buildVideo() {\n', buildUsers + '  function buildVideo() {\n'],
    [accessEnd, accessEnd + showUsers],
  ],
  'admin-config.js',
);
