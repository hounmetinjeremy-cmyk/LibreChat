(function () {
  var ROLES = [
    { id: 'aube', title: 'Aube', help: 'Modèle rapide et économique.' },
    { id: 'soleil', title: 'Soleil', help: 'Le grand modèle.' }
  ];
  var PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'gemini', label: 'Gemini (Google)' }
  ];
  var MODELS = {
    deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']
  };
  var intro = document.getElementById('intro');
  var fieldsBox = document.getElementById('fields');
  var saveBtn = document.getElementById('save');
  var statusEl = document.getElementById('status');
  var token = null;
  var refs = {};

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

  function keyField(id, label, help, onClear) {
    var state = el('div', { className: 'state' });
    var input = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Coller la clé ici (vide = inchangée)' });
    var clear = el('button', { type: 'button', textContent: 'Effacer' });
    clear.addEventListener('click', function () {
      if (!window.confirm('Effacer cette clé ?')) { return; }
      setStatus('Suppression…');
      onClear().then(function () { setStatus('Clé effacée.', 'ok'); })
        .catch(function (e) { setStatus(e.message, 'err'); });
    });
    var wrap = el('div', { className: 'field' }, [
      el('label', { textContent: label }),
      el('div', { className: 'help', textContent: help }),
      state,
      el('div', { className: 'row' }, [input, clear])
    ]);
    return { wrap: wrap, input: input, state: state };
  }

  function showState(ref, info) {
    var i = info || { set: false, hint: '' };
    if (i.set) {
      ref.state.textContent = 'Enregistrée (' + i.hint + ')';
      ref.state.className = 'state ok';
    } else if (i.viaServer) {
      ref.state.textContent = 'Clé du serveur utilisée (rien enregistré ici)';
      ref.state.className = 'state ok';
    } else {
      ref.state.textContent = 'Pas encore enregistrée';
      ref.state.className = 'state';
    }
    ref.input.value = '';
  }

  function fillModels(list, provider) {
    list.textContent = '';
    (MODELS[provider] || []).forEach(function (m) { list.appendChild(el('option', { value: m })); });
  }

  function buildRole(role) {
    var provider = el('select', {}, PROVIDERS.map(function (p) { return el('option', { value: p.id, textContent: p.label }); }));
    var model = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    var list = el('datalist', { id: 'models-' + role.id });
    model.setAttribute('list', list.id);
    provider.addEventListener('change', function () {
      fillModels(list, provider.value);
      model.value = (MODELS[provider.value] || [''])[0];
    });
    var key = keyField(role.id, 'Clé du fournisseur', 'Utilisée seulement pour ' + role.title + '.', function () {
      var b = {}; b[role.id] = { key: null };
      return api('/api/admin-models', 'PUT', b).then(renderModels);
    });
    var card = el('div', { className: 'card' }, [
      el('h2', { textContent: role.title }),
      el('div', { className: 'help', textContent: role.help + ' Ce que tu choisis ici, c’est ce qui répond quand l’utilisateur choisit « ' + role.title + ' ».' }),
      el('div', { className: 'field' }, [el('label', { textContent: 'Fournisseur' }), provider]),
      el('div', { className: 'field' }, [el('label', { textContent: 'Modèle' }), model, list]),
      key.wrap
    ]);
    fieldsBox.appendChild(card);
    refs[role.id] = { provider: provider, model: model, list: list, key: key };
  }

  function buildVision() {
    var model = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });
    var key = keyField('vision', 'Clé Gemini', 'Si vide et qu’un modèle utilise Gemini, sa clé sert aussi à lire les images et PDF.', function () {
      return api('/api/admin-models', 'PUT', { vision: { key: null } }).then(renderModels);
    });
    fieldsBox.appendChild(el('div', { className: 'card' }, [
      el('h2', { textContent: 'Lecture des images et PDF' }),
      el('div', { className: 'help', textContent: 'Gemini lit les pièces jointes puis transmet le texte au modèle choisi.' }),
      key.wrap,
      el('div', { className: 'field' }, [el('label', { textContent: 'Modèle Gemini de lecture' }), model])
    ]));
    refs.vision = { model: model, key: key };
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
      fillModels(r.list, r.provider.value);
      r.model.value = d.model || '';
      showState(r.key, d);
    });
    var v = data.vision || {};
    refs.vision.model.value = v.model || '';
    showState(refs.vision.key, v);
  }

  function renderVideo(data) {
    showState(refs.video.key, data && data.video);
  }

  function showLoginNeeded(text) {
    intro.textContent = text + ' ';
    var a = document.createElement('a');
    a.href = '/';
    a.textContent = 'Ouvrir l’application';
    intro.appendChild(a);
  }

  saveBtn.addEventListener('click', function () {
    var body = { vision: {} };
    ROLES.forEach(function (role) {
      var r = refs[role.id];
      var item = { provider: r.provider.value, model: r.model.value.trim() };
      var k = r.key.input.value.trim();
      if (k) { item.key = k; }
      body[role.id] = item;
    });
    var vm = refs.vision.model.value.trim();
    if (vm) { body.vision.model = vm; }
    var vk = refs.vision.key.input.value.trim();
    if (vk) { body.vision.key = vk; }
    var videoKey = refs.video.key.input.value.trim();
    saveBtn.disabled = true;
    setStatus('Enregistrement…');
    api('/api/admin-models', 'PUT', body)
      .then(function (d) {
        renderModels(d);
        if (!videoKey) { return null; }
        return api('/api/admin-keys', 'PUT', { video: videoKey }).then(renderVideo);
      })
      .then(function () { setStatus('Enregistré. Les utilisateurs n’ont rien à saisir.', 'ok'); })
      .catch(function (e) { setStatus(e.message, 'err'); })
      .then(function () { saveBtn.disabled = false; });
  });

  fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(function (r) { return r.text(); })
    .then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!data || !data.token || !data.user) { showLoginNeeded('Connecte-toi d’abord avec ton compte administrateur.'); return null; }
      if (data.user.role !== 'ADMIN') { intro.textContent = 'Cette page est réservée au compte administrateur.'; return null; }
      token = data.token;
      intro.textContent = 'Choisis pour Aube et Soleil le fournisseur, le modèle et la clé. Les utilisateurs voient seulement « Aube » et « Soleil ».';
      ROLES.forEach(buildRole);
      buildVision();
      buildVideo();
      saveBtn.hidden = false;
      return api('/api/admin-models', 'GET').then(renderModels)
        .then(function () { return api('/api/admin-keys', 'GET'); }).then(renderVideo);
    })
    .catch(function (e) { setStatus(e && e.message ? e.message : 'Erreur de chargement.', 'err'); });
})();
