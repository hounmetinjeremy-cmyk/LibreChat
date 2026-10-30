/**
 * Connexion GitHub intégrée à LibreChat (route /api/github-link).
 *
 * Deux façons de connecter son compte GitHub, qui rangent le même token chiffré :
 *  1. Serveur MCP « connexion-github » (bouton + de l'interface) : /mcp et /oauth/* font de ce
 *     fichier un vrai serveur MCP avec connexion OAuth ; GitHub est le fournisseur d'identité.
 *  2. Lien signé donné par le terminal (/start) quand GitHub n'est pas encore connecté.
 *
 * L'orchestrateur lit le token par /token (Bearer ORCHESTRATOR_SECRET). Le modèle ne le voit jamais.
 * Variables Fly : GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, ORCHESTRATOR_SECRET.
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

const router = express.Router();
const wellKnown = express.Router();

const COL = {
  links: 'github_links',
  clients: 'github_mcp_clients',
  txns: 'github_mcp_txns',
  codes: 'github_mcp_codes',
  tokens: 'github_mcp_tokens',
};
const col = (name) => mongoose.connection.collection(name);
const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;

const orchestratorSecret = () => process.env.ORCHESTRATOR_SECRET || '';
const clientId = () => process.env.GITHUB_OAUTH_CLIENT_ID || '';
const clientSecret = () => process.env.GITHUB_OAUTH_CLIENT_SECRET || '';
const baseUrl = () => (process.env.DOMAIN_SERVER || '').replace(/\/$/, '');
const callbackUrl = () => `${baseUrl()}/api/github-link/callback`;

const rand = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
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

const configured = () => Boolean(clientId() && clientSecret() && orchestratorSecret());

/** Échange le code GitHub contre un token et récupère le nom du compte. */
async function githubExchange(code) {
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
  return { token, login };
}

const githubAuthorizeUrl = (state) =>
  `https://github.com/login/oauth/authorize?${new URLSearchParams({
    client_id: clientId(),
    redirect_uri: callbackUrl(),
    scope: 'repo',
    state,
    allow_signup: 'false',
  }).toString()}`;

/* ------------------------------------------------------------------ lien signé (terminal) */

router.get('/start', (req, res) => {
  if (!configured()) {
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
  return res.redirect(githubAuthorizeUrl(state));
});

/** Retour GitHub pour le lien signé. */
async function linkCallback(req, res) {
  const { code, state } = req.query;
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
  const { token, login } = await githubExchange(code);
  await col(COL.links).updateOne(
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
}

/** Retour GitHub pour la connexion depuis le bouton + (serveur MCP). */
async function mcpCallback(req, res) {
  const { code, state } = req.query;
  if (typeof code !== 'string' || typeof state !== 'string') {
    throw new Error('requête invalide');
  }
  const txn = await col(COL.txns).findOne({ _id: state.slice(2) });
  if (!txn || txn.exp < Date.now()) {
    throw new Error('transaction expirée');
  }
  await col(COL.txns).deleteOne({ _id: txn._id });
  const { token, login } = await githubExchange(code);
  const ourCode = rand(24);
  await col(COL.codes).insertOne({
    _id: ourCode,
    clientId: txn.clientId,
    redirectUri: txn.redirectUri,
    codeChallenge: txn.codeChallenge,
    ghEnc: encrypt(token),
    login,
    exp: Date.now() + 5 * 60000,
  });
  const back = new URL(txn.redirectUri);
  back.searchParams.set('code', ourCode);
  if (txn.state) {
    back.searchParams.set('state', txn.state);
  }
  return res.redirect(back.toString());
}

router.get('/callback', async (req, res) => {
  try {
    if (typeof req.query.state === 'string' && req.query.state.startsWith('m.')) {
      return await mcpCallback(req, res);
    }
    return await linkCallback(req, res);
  } catch (err) {
    logger.warn(`[github-link] connexion échouée : ${err?.message || 'erreur'}`);
    return send(res, 400, 'Connexion GitHub échouée', 'Réessaie depuis le chat pour obtenir une nouvelle connexion.');
  }
});

/* ------------------------------------------------------------------ lecture par l'orchestrateur */

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
    const doc = await col(COL.links).findOne({ _id: user });
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

/* ------------------------------------------------------------------ serveur OAuth du serveur MCP */

const mcpUrl = () => `${baseUrl()}/api/github-link/mcp`;

const protectedResource = (_req, res) =>
  res.json({
    resource: mcpUrl(),
    authorization_servers: [baseUrl()],
    bearer_methods_supported: ['header'],
    resource_name: 'GitHub',
  });

const authorizationServer = (_req, res) =>
  res.json({
    issuer: baseUrl(),
    authorization_endpoint: `${baseUrl()}/api/github-link/oauth/authorize`,
    token_endpoint: `${baseUrl()}/api/github-link/oauth/token`,
    registration_endpoint: `${baseUrl()}/api/github-link/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['repo'],
  });

wellKnown.get('/.well-known/oauth-protected-resource', protectedResource);
wellKnown.get('/.well-known/oauth-protected-resource/api/github-link/mcp', protectedResource);
wellKnown.get('/.well-known/oauth-authorization-server', authorizationServer);
wellKnown.get('/.well-known/oauth-authorization-server/api/github-link/mcp', authorizationServer);

router.post('/oauth/register', async (req, res) => {
  try {
    const body = req.body || {};
    const uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter(
          (u) => typeof u === 'string' && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1))/.test(u),
        )
      : [];
    if (!uris.length) {
      return res
        .status(400)
        .json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris requis' });
    }
    const client = {
      client_id: rand(16),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      client_name: String(body.client_name || 'client').slice(0, 100),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
    await col(COL.clients).insertOne({ _id: client.client_id, ...client });
    return res.status(201).json(client);
  } catch (_err) {
    logger.warn('[github-link] enregistrement du client impossible');
    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/oauth/authorize', async (req, res) => {
  try {
    const q = req.query;
    const client = typeof q.client_id === 'string' ? await col(COL.clients).findOne({ _id: q.client_id }) : null;
    if (!client || typeof q.redirect_uri !== 'string' || !client.redirect_uris.includes(q.redirect_uri)) {
      return send(res, 400, 'Demande invalide', 'Client inconnu ou adresse de retour non autorisée.');
    }
    if (q.response_type !== 'code' || typeof q.code_challenge !== 'string' || q.code_challenge_method !== 'S256') {
      return send(res, 400, 'Demande invalide', 'Paramètres de connexion incomplets.');
    }
    if (!configured()) {
      return send(res, 503, 'Connexion GitHub indisponible', "La connexion GitHub n'est pas encore configurée sur le serveur.");
    }
    const txn = rand(16);
    await col(COL.txns).insertOne({
      _id: txn,
      clientId: client._id,
      redirectUri: q.redirect_uri,
      state: typeof q.state === 'string' ? q.state : '',
      codeChallenge: q.code_challenge,
      exp: Date.now() + 10 * 60000,
    });
    return res.redirect(githubAuthorizeUrl(`m.${txn}`));
  } catch (_err) {
    logger.warn('[github-link] autorisation impossible');
    return send(res, 500, 'Erreur', 'Réessaie dans un instant.');
  }
});

async function issueTokens(forClient, ghEnc, login) {
  const access = `ghm_${rand(24)}`;
  const refresh = `ghr_${rand(24)}`;
  const accessMs = 30 * 24 * 3600 * 1000;
  await col(COL.tokens).insertMany([
    { _id: sha256(access), kind: 'access', clientId: forClient, ghEnc, login, exp: Date.now() + accessMs },
    { _id: sha256(refresh), kind: 'refresh', clientId: forClient, ghEnc, login, exp: Date.now() + 90 * 24 * 3600 * 1000 },
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: Math.floor(accessMs / 1000),
    refresh_token: refresh,
  };
}

router.post('/oauth/token', async (req, res) => {
  const body = req.body || {};
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  const fail = (status, error, description) =>
    res.status(status).json({ error, error_description: description });
  try {
    if (body.grant_type === 'authorization_code') {
      const doc = typeof body.code === 'string' ? await col(COL.codes).findOne({ _id: body.code }) : null;
      if (doc) {
        await col(COL.codes).deleteOne({ _id: doc._id });
      }
      if (!doc || doc.exp < Date.now() || doc.clientId !== body.client_id) {
        return fail(400, 'invalid_grant', 'code invalide ou expiré');
      }
      if (body.redirect_uri && body.redirect_uri !== doc.redirectUri) {
        return fail(400, 'invalid_grant', 'redirect_uri différent');
      }
      const challenge =
        typeof body.code_verifier === 'string'
          ? crypto.createHash('sha256').update(body.code_verifier).digest().toString('base64url')
          : '';
      if (!challenge || !safeEq(challenge, doc.codeChallenge)) {
        return fail(400, 'invalid_grant', 'PKCE invalide');
      }
      return res.json(await issueTokens(doc.clientId, doc.ghEnc, doc.login));
    }
    if (body.grant_type === 'refresh_token') {
      const doc =
        typeof body.refresh_token === 'string'
          ? await col(COL.tokens).findOne({ _id: sha256(body.refresh_token), kind: 'refresh' })
          : null;
      if (!doc || doc.exp < Date.now() || (body.client_id && doc.clientId !== body.client_id)) {
        return fail(400, 'invalid_grant', 'refresh_token invalide');
      }
      await col(COL.tokens).deleteOne({ _id: doc._id });
      return res.json(await issueTokens(doc.clientId, doc.ghEnc, doc.login));
    }
    return fail(400, 'unsupported_grant_type', 'grant_type non géré');
  } catch (_err) {
    logger.warn('[github-link] échange de token impossible');
    return fail(500, 'server_error', 'erreur interne');
  }
});

/* ------------------------------------------------------------------ serveur MCP « connexion-github » */

router.post('/mcp', async (req, res) => {
  const unauthorized = () =>
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource/api/github-link/mcp"`,
      )
      .json({ error: 'invalid_token' });
  try {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!m) {
      return unauthorized();
    }
    const doc = await col(COL.tokens).findOne({ _id: sha256(m[1]), kind: 'access' });
    if (!doc || doc.exp < Date.now()) {
      return unauthorized();
    }

    // Rattache le compte GitHub à l'utilisateur LibreChat (en-têtes posés par le serveur LibreChat).
    const userId = String(req.headers['x-user-id'] || '');
    const linkKey = String(req.headers['x-link-key'] || '');
    if (USER_RE.test(userId) && orchestratorSecret() && safeEq(linkKey, orchestratorSecret())) {
      await col(COL.links).updateOne(
        { _id: userId },
        { $set: { tokenEnc: doc.ghEnc, login: doc.login || '', updatedAt: new Date() } },
        { upsert: true },
      );
    }

    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const server = new McpServer({ name: 'connexion-github', version: '1.0.0' });
    server.tool(
      'github_status',
      "Indique quel compte GitHub est connecté. Le terminal s'en sert tout seul pour cloner : n'appeler que si l'utilisateur le demande.",
      {},
      async () => ({
        content: [{ type: 'text', text: doc.login ? `GitHub connecté : ${doc.login}.` : 'GitHub connecté.' }],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error(`[github-link] serveur MCP : ${err?.message || 'erreur'}`);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erreur interne' }, id: null });
    }
  }
});
router.all('/mcp', (_req, res) => res.status(405).json({ error: 'méthode non autorisée' }));

module.exports = router;
module.exports.wellKnown = wellKnown;
