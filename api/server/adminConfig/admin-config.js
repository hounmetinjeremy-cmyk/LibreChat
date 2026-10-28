(function () {
  var FIELDS = [
    { id: "deepseek", label: "Clé DeepSeek", help: "Utilisée par les modèles Aube et Soleil." },
    { id: "gemini", label: "Clé Gemini (Google)", help: "Lecture des images et PDF, et modèles Gemini." },
    { id: "modal", label: "Clé Modal (Jérémy GPU)", help: "Service GPU hébergé sur Modal." },
    { id: "video", label: "Clé du service vidéo", help: "Génération de vidéos." }
  ];
  var intro = document.getElementById("intro");
  var fieldsBox = document.getElementById("fields");
  var saveBtn = document.getElementById("save");
  var statusEl = document.getElementById("status");
  var token = null;
  var inputs = {};
  var states = {};

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function renderState(data) {
    FIELDS.forEach(function (f) {
      var info = data[f.id] || { set: false, hint: "" };
      states[f.id].textContent = info.set ? "Enregistrée (" + info.hint + ")" : "Pas encore enregistrée";
      states[f.id].className = "state" + (info.set ? " ok" : "");
      inputs[f.id].value = "";
    });
  }

  function api(method, body) {
    return fetch("/api/admin-keys", {
      method: method,
      headers: Object.assign({ Authorization: "Bearer " + token }, body ? { "Content-Type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include"
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) { throw new Error(data && data.message ? data.message : "Erreur " + r.status); }
        return data;
      });
    });
  }

  function buildForm() {
    FIELDS.forEach(function (f) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var label = document.createElement("label");
      label.textContent = f.label;
      label.htmlFor = "k-" + f.id;
      var help = document.createElement("div");
      help.className = "help";
      help.textContent = f.help;
      var state = document.createElement("div");
      state.className = "state";
      var row = document.createElement("div");
      row.className = "row";
      var input = document.createElement("input");
      input.type = "password";
      input.id = "k-" + f.id;
      input.autocomplete = "off";
      input.placeholder = "Coller la clé ici (vide = inchangée)";
      var clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Effacer";
      clear.addEventListener("click", function () {
        if (!window.confirm("Effacer cette clé ?")) { return; }
        var body = {}; body[f.id] = null;
        setStatus("Suppression…");
        api("PUT", body).then(function (d) { renderState(d); setStatus("Clé effacée.", "ok"); })
          .catch(function (e) { setStatus(e.message, "err"); });
      });
      row.appendChild(input); row.appendChild(clear);
      wrap.appendChild(label); wrap.appendChild(help); wrap.appendChild(state); wrap.appendChild(row);
      fieldsBox.appendChild(wrap);
      inputs[f.id] = input; states[f.id] = state;
    });
  }

  function showLoginNeeded(text) {
    intro.textContent = text + " ";
    var a = document.createElement("a");
    a.href = "/";
    a.textContent = "Ouvrir l’application";
    intro.appendChild(a);
  }

  saveBtn.addEventListener("click", function () {
    var body = {};
    FIELDS.forEach(function (f) { var v = inputs[f.id].value.trim(); if (v) { body[f.id] = v; } });
    if (!Object.keys(body).length) { setStatus("Rien à enregistrer.", "err"); return; }
    saveBtn.disabled = true;
    setStatus("Enregistrement…");
    api("PUT", body).then(function (d) { renderState(d); setStatus("Clés enregistrées. Les utilisateurs n’ont rien à saisir.", "ok"); })
      .catch(function (e) { setStatus(e.message, "err"); })
      .then(function () { saveBtn.disabled = false; });
  });

  fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
    .then(function (r) { return r.text(); })
    .then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      if (!data || !data.token || !data.user) { showLoginNeeded("Connecte-toi d’abord avec ton compte administrateur."); return; }
      if (data.user.role !== "ADMIN") { intro.textContent = "Cette page est réservée au compte administrateur."; return; }
      token = data.token;
      intro.textContent = "Colle chaque clé une seule fois : tous les utilisateurs s’en serviront sans rien saisir.";
      buildForm();
      saveBtn.hidden = false;
      return api("GET").then(renderState);
    })
    .catch(function (e) { setStatus(e && e.message ? e.message : "Erreur de chargement.", "err"); });
})();
