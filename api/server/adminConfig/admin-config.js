(function () {
  var ROLES = [
    { id: 'aube', title: 'Aube', help: 'Modèle rapide et économique.' },
    { id: 'soleil', title: 'Soleil', help: 'Le grand modèle.' }
  ];
  var PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'gemini', label: 'Gemini (Google)' },
    { id: 'cloudflare', label: 'Cloudflare Workers AI' }
  ];
  var LABEL = { deepseek: 'DeepSeek', gemini: 'Gemini', cloudflare: 'Cloudflare' };
  /* Listes de secours, utilisées seulement si la liste en direct du fournisseur est indisponible. */
  var MODELS = {
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
    cloudflare: ['@cf/openai/gpt-oss-120b', '@cf/openai/gpt-oss-20b', '@cf/zai-org/glm-4.7-flash', '@cf/google/gemma-4-26b-a4b-it', '@cf/moonshotai/kimi-k2.6']
  };
  var CUSTOM = '__custom__';
  var live = {};
  var liveBox = null;
  var intro = document.getElementById('intro');
  var fieldsBox = document.getElementById('fields');
  var saveBtn = document.getElementById('save');
  var statusEl = document.getElementById('status');
  var token = null;
  var refs = {};
  var loading = false;

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function el(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { n[k] = props[k]; });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function api(url, method, body) {
    return fetch(url, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include'
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) { throw new Error(data && data.message ? data.message : 'Erreur ' + r.status); }
        return data;
      });
    });
  }

  /* plain = champ texte lisible (ID de compte), sinon champ masqué pour une clé. */
  function keyField(id, label, help, onClear, plain) {
    var state = el('div', { className: 'state' });
    var input = plain
      ? el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'Coller l’ID ici (vide = inchangé)' })
      : el('input', { type: 'password', autocomplete: 'off', placeholder: 'Coller la clé ici (vide = inchangée)' });
    var clear = el('button', { type: 'button', textContent: 'Effacer' });
    clear.addEventListener('click', function () {
      if (!window.confirm(plain ? 'Effacer cet ID ?' : 'Effacer cette clé ?')) { return; }
      setStatus('Suppression…');
      onClear().then(function () { setStatus(plain ? 'ID effacé.' : 'Clé effacée.', 'ok'); })
        .catch(function (e) { setStatus(e.message, 'err'); });
    });
    var wrap = el('div', { className: 'field' }, [
      el('label', { textContent: label }),
      el('div', { className: 'help', textContent: help }),
      state,
      el('div', { className: 'row' }, [input, clear])
    ]);
    return { wrap: wrap, input: input, state: state, plain: Boolean(plain) };
  }

  function showState(ref, info) {
    var i = info || { set: false, hint: '' };
    if (i.set) {
      ref.state.textContent = (ref.plain ? 'Enregistré (' : 'Enregistrée (') + i.hint + ')';
      ref.state.className = 'state ok';
    } else if (i.viaServer) {
      ref.state.textContent = (ref.plain ? 'ID du serveur utilisé' : 'Clé du serveur utilisée') + ' (rien enregistré ici)';
      ref.state.className = 'state ok';
    } else {
      ref.state.textContent = ref.plain ? 'Pas encore enregistré' : 'Pas encore enregistrée';
      ref.state.className = 'state';
    }
    ref.input.value = '';
  }

  /* Liste en direct du fournisseur si on l'a, sinon liste de secours. */
  function modelsFor(provider) {
    var l = live[provider];
    return l && l.models && l.models.length ? l.models : (MODELS[provider] || []);
  }

  /* Remplit le menu des modèles et l'aligne sur la valeur du champ caché (celle qu'on enregistre). */
  function syncSelect(r) {
    var provider = r.provider.value;
    var list = modelsFor(provider);
    var l = live[provider];
    var known = Boolean(l && l.models && l.models.length);
    var current = r.model.value.trim();
    r.select.textContent = '';
    list.forEach(function (m) { r.select.appendChild(el('option', { value: m, textContent: m })); });
    if (current && list.indexOf(current) === -1) {
      var note = known ? ' (n’existe plus chez ce fournisseur ?)' : ' (actuel)';
      r.select.appendChild(el('option', { value: current, textContent: current + note }));
    }
    r.select.appendChild(el('option', { value: CUSTOM, textContent: 'Autre modèle (saisir le nom)…' }));
    if (!current && list.length) { r.model.value = list[0]; current = list[0]; }
    r.select.value = current || CUSTOM;
    r.model.style.display = r.select.value === CUSTOM ? '' : 'none';
  }

  /* Demande au serveur la liste des modèles de chaque fournisseur (avec les clés enregistrées). */
  function loadLive() {
    if (!liveBox) { return Promise.resolve(); }
    liveBox.textContent = 'Chargement des modèles de chaque fournisseur…';
    liveBox.className = 'state';
    return api('/api/admin-models/available', 'GET').then(function (data) {
      live = data || {};
      ROLES.forEach(function (role) { syncSelect(refs[role.id]); });
      liveBox.textContent = PROVIDERS.map(function (p) {
        var l = live[p.id] || {};
        var n = (l.models || []).length;
        return p.label + ' : ' + (n ? n + ' modèles' : (l.error || 'aucun'));
      }).join(' · ');
      liveBox.className = 'state ok';
    }).catch(function (e) {
      liveBox.textContent = 'Liste en direct indisponible (' + (e && e.message ? e.message : 'erreur') + ') : liste de secours utilisée.';
      liveBox.className = 'state';
    });
  }

  function buildLive() {
    liveBox = el('div', { className: 'state' });
    var refresh = el('button', { type: 'button', textContent: 'Actualiser la liste des modèles' });
    refresh.addEventListener('click', function () { loadLive(); });
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Modèles disponibles' }),
      el('div', { className: 'help', textContent: 'La liste de chaque fournisseur est demandée en direct avec ta clé : les modèles retirés n’apparaissent plus et les nouveaux arrivent tout seuls.' }),
      liveBox,
      el('div', { className: 'row' }, [refresh])
    ]));
  }

  /* Clés : on peut en mettre plusieurs, le serveur bascule tout seul de l’une à l’autre. */
  function buildKeys() {
    var deepseek = keyField('deepseek', 'Clé DeepSeek', 'Utilisée par Aube et Soleil.', function () {
      return api('/api/admin-models', 'PUT', { keys: { deepseek: null } }).then(renderModels);
    });
    var gemini = keyField('gemini', 'Clé Gemini (Google)', 'Utilisée par Aube et Soleil, et pour lire les images et PDF.', function () {
      return api('/api/admin-models', 'PUT', { keys: { gemini: null } }).then(renderModels);
    });
    var cloudflare = keyField('cloudflare', 'Clé Cloudflare Workers AI', 'Jeton API Cloudflare avec la permission Workers AI. Utilisé par Aube et Soleil, avec l’ID de compte ci-dessous.', function () {
      return api('/api/admin-models', 'PUT', { keys: { cloudflare: null } }).then(renderModels);
    });
    var account = keyField('cloudflare-account', 'ID de compte Cloudflare', 'Identifiant du compte Cloudflare (obligatoire pour utiliser la clé Cloudflare).', function () {
      return api('/api/admin-models', 'PUT', { cloudflareAccount: null }).then(renderModels);
    }, true);
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Clés API' }),
      el('div', { className: 'help', textContent: 'Ajoute les clés que tu as. Si l’une est refusée, vide ou en panne, le serveur bascule automatiquement sur une autre. Aube et Soleil marchent avec n’importe laquelle.' }),
      deepseek.wrap,
      gemini.wrap,
      cloudflare.wrap,
      account.wrap
    ]));
    refs.keys = { deepseek: deepseek, gemini: gemini, cloudflare: cloudflare };
    refs.account = account;
  }

  function buildRole(role) {
    var provider = el('select', {}, PROVIDERS.map(function (p) { return el('option', { value: p.id, textContent: p.label }); }));
    var model = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, placeholder: 'Nom exact du modèle' });
    var select = el('select', {});
    var chain = el('div', { className: 'state' });
    provider.addEventListener('change', function () {
      model.value = modelsFor(provider.value)[0] || '';
      syncSelect(refs[role.id]);
    });
    select.addEventListener('change', function () {
      if (select.value === CUSTOM) {
        model.value = '';
        model.style.display = '';
        model.focus();
        return;
      }
      model.value = select.value;
      model.style.display = 'none';
    });
    var card = el('div', { className: 'card' }, [
      el('h2', { textContent: role.title }),
      el('div', { className: 'help', textContent: role.help + ' Fournisseur essayé en premier ; si sa clé échoue, un autre prend le relais.' }),
      el('div', { className: 'field' }, [el('label', { textContent: 'Fournisseur préféré' }), provider]),
      el('div', { className: 'field' }, [el('label', { textContent: 'Modèle' }), select, model]),
      chain
    ]);
    fieldsBox.appendChild(card);
    refs[role.id] = { provider: provider, model: model, select: select, chain: chain };
  }

  function buildVision() {
    var model = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Lecture des images et PDF' }),
      el('div', { className: 'help', textContent: 'Gemini lit les pièces jointes puis transmet le texte au modèle choisi (utilise la clé Gemini ci-dessus).' }),
      el('div', { className: 'field' }, [el('label', { textContent: 'Modèle Gemini de lecture' }), model])
    ]));
    refs.vision = { model: model };
  }

  function buildVideo() {
    var key = keyField('video', 'Clé du service vidéo', 'Génération de vidéos.', function () {
      return api('/api/admin-keys', 'PUT', { video: null }).then(renderVideo);
    });
    fieldsBox.appendChild(el('div', { className: 'card' }, [el('h2', { textContent: 'Vidéo' }), key.wrap]));
    refs.video = { key: key };
  }

  function renderModels(data) {
    ROLES.forEach(function (role) {
      var d = data[role.id] || {};
      var r = refs[role.id];
      r.provider.value = d.provider || 'deepseek';
      r.model.value = d.model || '';
      syncSelect(r);
      var chain = d.chain || [];
      if (chain.length) {
        r.chain.textContent = 'Ordre d’essai : ' + chain.map(function (p) { return LABEL[p] || p; }).join(' → ');
        r.chain.className = 'state ok';
      } else {
        r.chain.textContent = 'Aucune clé disponible : ajoute une clé ci-dessus';
        r.chain.className = 'state';
      }
    });
    var keys = data.keys || {};
    showState(refs.keys.deepseek, keys.deepseek);
    showState(refs.keys.gemini, keys.gemini);
    showState(refs.keys.cloudflare, keys.cloudflare);
    showState(refs.account, data.cloudflare);
    var v = data.vision || {};
    refs.vision.model.value = v.model || '';
  }

  function renderVideo(data) {
    showState(refs.video.key, data && data.video);
  }

  function showLoginNeeded(text, code) {
    intro.textContent = text + (code ? ' (code ' + code + ') ' : ' ');
    var a = document.createElement('a');
    a.href = '/';
    a.textContent = 'Ouvrir l’application';
    intro.appendChild(a);
    intro.appendChild(document.createTextNode(' puis '));
    var retry = document.createElement('a');
    retry.href = '#';
    retry.textContent = 'Réessayer';
    retry.addEventListener('click', function (e) { e.preventDefault(); start(); });
    intro.appendChild(retry);
    intro.appendChild(document.createTextNode('.'));
  }

  saveBtn.addEventListener('click', function () {
    var body = { vision: {}, keys: {} };
    ROLES.forEach(function (role) {
      var r = refs[role.id];
      body[role.id] = { provider: r.provider.value, model: r.model.value.trim() };
    });
    ['deepseek', 'gemini', 'cloudflare'].forEach(function (p) {
      var k = refs.keys[p].input.value.trim();
      if (k) { body.keys[p] = k; }
    });
    var acc = refs.account.input.value.trim();
    if (acc) { body.cloudflareAccount = acc; }
    var vm = refs.vision.model.value.trim();
    if (vm) { body.vision.model = vm; }
    var videoKey = refs.video.key.input.value.trim();
    saveBtn.disabled = true;
    setStatus('Enregistrement…');
    api('/api/admin-models', 'PUT', body)
      .then(function (d) {
        renderModels(d);
        loadLive();
        if (!videoKey) { return null; }
        return api('/api/admin-keys', 'PUT', { video: videoKey }).then(renderVideo);
      })
      .then(function () { setStatus('Enregistré. Les utilisateurs n’ont rien à saisir.', 'ok'); })
      .catch(function (e) { setStatus(e.message, 'err'); })
      .then(function () { saveBtn.disabled = false; });
  });

  /* Vérifie la connexion ; relancée au retour sur la page (bouton « retour » du navigateur). */
  function start() {
    if (token || loading) { return; }
    loading = true;
    var code = null;
    fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', cache: 'no-store' })
      .then(function (r) { code = r.status; return r.text(); })
      .then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data || !data.token || !data.user) { showLoginNeeded('Connecte-toi d’abord avec ton compte administrateur.', code); return null; }
        if (data.user.role !== 'ADMIN') { intro.textContent = 'Cette page est réservée au compte administrateur.'; return null; }
        token = data.token;
        intro.textContent = 'Ajoute tes clés API (plusieurs possibles : bascule automatique) et choisis le modèle d’Aube et de Soleil. Les utilisateurs voient seulement « Aube » et « Soleil ».';
        buildKeys();
        buildLive();
        ROLES.forEach(buildRole);
        buildVision();
        buildVideo();
        saveBtn.hidden = false;
        return api('/api/admin-models', 'GET').then(renderModels)
          .then(function () { loadLive(); return api('/api/admin-keys', 'GET'); }).then(renderVideo);
      })
      .catch(function (e) { setStatus(e && e.message ? e.message : 'Erreur de chargement.', 'err'); })
      .then(function () { loading = false; });
  }

  window.addEventListener('pageshow', function () { start(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { start(); } });
  start();
})();
