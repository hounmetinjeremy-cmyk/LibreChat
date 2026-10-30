/**
 * Connexion GitHub intégrée à LibreChat.
 * - GET /api/github-link/start    : lien signé par l'orchestrateur -> page d'autorisation GitHub.
 * - GET /api/github-link/callback : GitHub revient ici ; le token de l'utilisateur est chiffré et rangé en base.
 * - GET /api/github-link/token    : lu uniquement par l'orchestrateur (Bearer ORCHESTRATOR_SECRET).
 * Variables Fly : GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, ORCHESTRATOR_SECRET.
 * Le token n'est jamais écrit dans les journaux ni envoyé au modèle.
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const router = express.Router();

const COLLECTION = 'github_links';
const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;

const orchestratorSecret = () => process.env.ORCHESTRATOR_SECRET || '';
const clientId = () => process.env.GITHUB_OAUTH_CLIENT_ID || '';
const clientSecret = () => process.env.GITHUB_OAUTH_CLIENT_SECRET || '';
const baseUrl = () => (process.env.DOMAIN_SERVER || '').replace(/\/$/, '');
const callbackUrl = () => `${baseUrl()}/api/github-link/callback`;

const hmac = (value) =>
  crypto.createHmac('sha256', orchestratorSecret()).update(value).digest('hex');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const encKey = () =>
  crypto
    .createHash('sha256')
    .update(process.env.CREDS_KEY || orchestratorSecret())
    .digest();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(payload) {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const page = (title, body) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f7fb;color:#111">` +
  `<main style="max-width:420px;padding:32px;text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#444;line-height:1.5">${body}</p></main></body></html>`;

const send = (res, status, title, body) =>
  res
    .status(status)
    .set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' })
    .send(page(title, body));

router.get('/start', (req, res) => {
  if (!clientId() || !clientSecret() || !orchestratorSecret()) {
    return send(res, 503, 'Connexion GitHub indisponible', "La connexion GitHub n'est pas encore configurée sur le serveur.");
  }
  const { u, e, s } = req.query;
  const exp = Number(e);
  const now = Date.now();
  if (
    typeof u !== 'string' ||
    !USER_RE.test(u) ||
    !Number.isFinite(exp) ||
    exp < now ||
    exp > now + 3600000 ||
    typeof s !== 'string' ||
    !safeEq(s, hmac(`${u}.${exp}`))
  ) {
    return send(res, 400, 'Lien invalide ou expiré', 'Redemande ta tâche dans le chat pour obtenir un nouveau lien.');
  }
  const stateExp = now + 10 * 60000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const state = `${u}.${stateExp}.${nonce}.${hmac(`st:${u}.${stateExp}.${nonce}`)}`;
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callbackUrl(),
    scope: 'repo',
    state,
    allow_signup: 'false',
  });
  return res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const parts = typeof state === 'string' ? state.split('.') : [];
    if (typeof code !== 'string' || parts.length !== 4) {
      throw new Error('requête invalide');
    }
    const [u, stateExp, nonce, sig] = parts;
    if (
      !USER_RE.test(u) ||
      !(Number(stateExp) > Date.now()) ||
      !safeEq(sig, hmac(`st:${u}.${stateExp}.${nonce}`))
    ) {
      throw new Error('état invalide');
    }
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        redirect_uri: callbackUrl(),
      },
      { headers: { Accept: 'application/json' }, timeout: 15000 },
    );
    const token = tokenRes.data?.access_token;
    if (!token) {
      throw new Error('token absent');
    }
    let login = '';
    try {
      const me = await axios.get('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'jeremy-librechat' },
        timeout: 10000,
      });
      login = String(me.data?.login || '');
    } catch (_err) {
      login = '';
    }
    await mongoose.connection
      .collection(COLLECTION)
      .updateOne(
        { _id: u },
        { $set: { tokenEnc: encrypt(token), login, updatedAt: new Date() } },
        { upsert: true },
      );
    return send(
      res,
      200,
      'GitHub connecté ✅',
      `${login ? `Compte ${esc(login)} connecté. ` : ''}Retourne dans le chat et redemande ta tâche.`,
    );
  } catch (err) {
    logger.warn(`[github-link] connexion échouée : ${err?.message || 'erreur'}`);
    return send(res, 400, 'Connexion GitHub échouée', 'Redemande ta tâche dans le chat pour obtenir un nouveau lien.');
  }
});

router.get('/token', async (req, res) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!orchestratorSecret() || !m || !safeEq(m[1], orchestratorSecret())) {
    return res.status(401).json({ error: 'non autorisé' });
  }
  const user = req.query.user;
  if (typeof user !== 'string' || !USER_RE.test(user)) {
    return res.status(400).json({ error: 'user invalide' });
  }
  try {
    const doc = await mongoose.connection.collection(COLLECTION).findOne({ _id: user });
    if (!doc?.tokenEnc) {
      return res.status(404).json({ error: 'GitHub non connecté' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ token: decrypt(doc.tokenEnc), login: doc.login || '' });
  } catch (_err) {
    logger.error('[github-link] lecture du token impossible');
    return res.status(500).json({ error: 'erreur interne' });
  }
});

module.exports = router;
