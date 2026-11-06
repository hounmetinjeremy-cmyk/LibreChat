/**
 * Connexion Cloudflare par utilisateur (route /api/cloudflare-link) : déploiement sur Cloudflare Pages.
 *
 * Collection MongoDB « cloudflare_links » (un document par utilisateur LibreChat) :
 *   _id            : identifiant de l'utilisateur LibreChat (clé unique)
 *   tokenEnc       : jeton API Cloudflare chiffré en AES-256-GCM (iv.tag.données en base64)
 *   accountId      : identifiant de compte Cloudflare (32 caractères hexadécimaux)
 *   kind           : 'user' (jeton utilisateur) ou 'account' (jeton propre à un compte)
 *   status         : 'active' | 'invalid' (passé à invalid dès que Cloudflare répond 401/403)
 *   lastVerifiedAt, updatedAt, invalidAt : dates
 *
 * Routes pour l'utilisateur connecté (JWT) :
 *   POST   /connect   { token, account_id? }  vérifie le jeton, retrouve le compte, stocke chiffré
 *   GET    /status                            état de la connexion (jamais le jeton)
 *   DELETE /                                  déconnecte Cloudflare
 * Routes pour l'orchestrateur (Bearer ORCHESTRATOR_SECRET) ; le modèle ne voit jamais le jeton :
 *   GET    /credentials?user=ID               account_id + jeton déchiffré, à injecter dans CLOUDFLARE_API_TOKEN
 *                                             et CLOUDFLARE_ACCOUNT_ID du conteneur
 *   POST   /pages/project                     crée un projet Pages lié au dépôt GitHub de l'utilisateur
 *
 * Limites : au plus 1000 appels par 5 minutes et par compte (Cloudflare : 1200), et nouvel essai
 * automatique (Retry-After) en cas de 429. Un jeton refusé (401/403) renvoie une erreur claire
 * { error: 'cloudflare_token_invalid', reconnect: true }.
 * Variables Fly : ORCHESTRATOR_SECRET (et CREDS_KEY, facultatif, pour la clé de chiffrement).
 */
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

const COLLECTION = 'cloudflare_links';
const CF = 'https://api.cloudflare.com/client/v4';
const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ACCOUNT_RE = /^[a-f0-9]{32}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const DASH_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages';

const col = () => mongoose.connection.collection(COLLECTION);
const orchestratorSecret = () => process.env.ORCHESTRATOR_SECRET || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---------------------------------------------------------------- chiffrement */

const encKey = () =>
  crypto
    .createHash('sha256')
    .update('cloudflare-link:' + (process.env.CREDS_KEY || orchestratorSecret()))
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

/* ------------------------------------------------------------ limites d'appels */

const buckets = new Map();
function allow(key) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < 300000);
  if (arr.length >= 1000) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

const attempts = new Map();
function allowConnect(userId) {
  const now = Date.now();
  const arr = (attempts.get(userId) || []).filter((t) => now - t < 600000);
  if (arr.length >= 10) {
    attempts.set(userId, arr);
    return false;
  }
  arr.push(now);
  attempts.set(userId, arr);
  return true;
}

/** Appel à l'API Cloudflare avec limite locale et nouvel essai sur 429. */
async function cf(method, path, token, data, bucketKey) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!allow(bucketKey)) {
      return { status: 429, body: {}, retryAfter: 30 };
    }
    const r = await axios({
      method,
      url: CF + path,
      data,
      headers: Object.assign({ Authorization: `Bearer ${token}` }, data && !(data instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      timeout: 20000,
      validateStatus: () => true,
    });
    const retryAfter = Number(r.headers['retry-after']) || 0;
    if (r.status === 429 && attempt < 2) {
      await sleep(Math.min(retryAfter || 5, 15) * 1000);
      continue;
    }
    return { status: r.status, body: r.data || {}, retryAfter };
  }
  return { status: 429, body: {}, retryAfter: 30 };
}

const firstError = (r) =>
  (r.body && r.body.errors && r.body.errors[0] && r.body.errors[0].message) || 'erreur Cloudflare';

async function markInvalid(userId) {
  await col().updateOne(
    { _id: userId },
    { $set: { status: 'invalid', invalidAt: new Date() } },
  );
}

/** Réponse d'erreur normalisée : 401/403 = jeton à réautoriser, 429 = réessayer plus tard. */
function cfFail(res, userId, r) {
  if (r.status === 401 || r.status === 403) {
    if (userId) {
      markInvalid(userId).catch(() => {});
    }
    return res.status(r.status).json({
      error: 'cloudflare_token_invalid',
      reconnect: true,
      message:
        'Le jeton Cloudflare est invalide, révoqué ou sans les droits Pages. Reconnecte ton compte Cloudflare.',
      detail: firstError(r),
    });
  }
  if (r.status === 429) {
    const wait = r.retryAfter || 30;
    return res.status(429).set('Retry-After', String(wait)).json({
      error: 'rate_limited',
      retry_after: wait,
      message: 'Trop de requêtes vers Cloudflare, réessaie dans un instant.',
    });
  }
  const status = r.status >= 400 && r.status < 600 ? r.status : 502;
  return res.status(status).json({
    error: 'cloudflare_error',
    message: firstError(r),
    errors: (r.body && r.body.errors) || [],
  });
}

/* -------------------------------------------------- vérification d'un jeton */

async function verifyAndResolve(token, accountIdIn) {
  const key = 'verify:' + token.slice(0, 8);
  let accountId = accountIdIn || '';
  let kind = 'user';

  let v = await cf('GET', '/user/tokens/verify', token, null, key);
  let ok = v.status === 200 && v.body.success && v.body.result && v.body.result.status === 'active';

  let accounts = [];
  const list = await cf('GET', '/accounts?per_page=50', token, null, key);
  if (list.status === 200 && Array.isArray(list.body.result)) {
    accounts = list.body.result.map((a) => ({ id: a.id, name: a.name }));
  }
  if (!accountId && accounts.length === 1) {
    accountId = accounts[0].id;
  }
  if (!accountId && accounts.length > 1) {
    return { error: 'account_choice', accounts };
  }

  if (!ok) {
    if (!accountId) {
      return { error: 'account_id_required' };
    }
    v = await cf('GET', `/accounts/${accountId}/tokens/verify`, token, null, key);
    ok = v.status === 200 && v.body.success && v.body.result && v.body.result.status === 'active';
    kind = 'account';
  }
  if (!ok) {
    return { error: 'token_invalid' };
  }
  if (!accountId) {
    return { error: 'account_id_required' };
  }

  const pages = await cf('GET', `/accounts/${accountId}/pages/projects?per_page=1`, token, null, key);
  if (pages.status === 401 || pages.status === 403) {
    return { error: 'pages_permission' };
  }
  if (pages.status >= 400) {
    return { error: 'cloudflare_error', message: firstError(pages) };
  }
  return { ok: true, accountId, kind, accounts };
}

/* ------------------------------------------------ routes de l'utilisateur */

router.post('/connect', requireJwtAuth, async (req, res) => {
  const userId = String((req.user && (req.user.id || req.user._id)) || '');
  if (!USER_RE.test(userId)) {
    return res.status(400).json({ error: 'utilisateur invalide' });
  }
  if (!allowConnect(userId)) {
    return res.status(429).json({ error: 'rate_limited', message: 'Trop d\'essais, réessaie dans quelques minutes.' });
  }
  const token = String((req.body && req.body.token) || '').trim();
  const accountIdIn = String((req.body && req.body.account_id) || '').trim();
  if (!TOKEN_RE.test(token)) {
    return res.status(400).json({ error: 'token_invalid', message: 'Jeton Cloudflare invalide.' });
  }
  if (accountIdIn && !ACCOUNT_RE.test(accountIdIn)) {
    return res.status(400).json({ error: 'account_id_invalid', message: 'Identifiant de compte invalide.' });
  }
  try {
    const out = await verifyAndResolve(token, accountIdIn);
    if (!out.ok) {
      const messages = {
        account_choice: 'Plusieurs comptes Cloudflare trouvés : choisis-en un (account_id).',
        account_id_required: 'Identifiant de compte (account_id) requis pour ce jeton.',
        token_invalid: 'Jeton Cloudflare invalide ou révoqué.',
        pages_permission: 'Ce jeton n\'a pas le droit Cloudflare Pages : Edit.',
        cloudflare_error: out.message || 'Erreur Cloudflare.',
      };
      const status = out.error === 'token_invalid' || out.error === 'pages_permission' ? 401 : 422;
      return res.status(status).json({
        error: out.error,
        message: messages[out.error] || 'Connexion impossible.',
        accounts: out.accounts,
      });
    }
    const now = new Date();
    await col().updateOne(
      { _id: userId },
      {
        $set: {
          tokenEnc: encrypt(token),
          accountId: out.accountId,
          kind: out.kind,
          status: 'active',
          lastVerifiedAt: now,
          updatedAt: now,
        },
        $unset: { invalidAt: '' },
      },
      { upsert: true },
    );
    return res.status(200).set('Cache-Control', 'no-store').json({
      connected: true,
      account_id_tail: out.accountId.slice(-4),
      kind: out.kind,
    });
  } catch (err) {
    logger.warn(`[cloudflare-link] connexion impossible : ${err && err.message ? err.message : 'erreur'}`);
    return res.status(502).json({ error: 'cloudflare_error', message: 'Cloudflare injoignable.' });
  }
});

router.get('/status', requireJwtAuth, async (req, res) => {
  const userId = String((req.user && (req.user.id || req.user._id)) || '');
  try {
    const doc = USER_RE.test(userId) ? await col().findOne({ _id: userId }) : null;
    res.set('Cache-Control', 'no-store');
    if (!doc || !doc.tokenEnc) {
      return res.json({ connected: false });
    }
    return res.json({
      connected: doc.status === 'active',
      status: doc.status,
      reconnect: doc.status !== 'active',
      account_id_tail: String(doc.accountId || '').slice(-4),
      kind: doc.kind,
      updated_at: doc.updatedAt,
    });
  } catch (err) {
    return res.status(500).json({ error: 'erreur interne' });
  }
});

router.delete('/', requireJwtAuth, async (req, res) => {
  const userId = String((req.user && (req.user.id || req.user._id)) || '');
  try {
    if (USER_RE.test(userId)) {
      await col().deleteOne({ _id: userId });
    }
    return res.json({ connected: false });
  } catch (err) {
    return res.status(500).json({ error: 'erreur interne' });
  }
});

/* ----------------------------------------------- routes de l'orchestrateur */

const orchestratorOnly = (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!orchestratorSecret() || !m || !safeEq(m[1], orchestratorSecret())) {
    return res.status(401).json({ error: 'non autorisé' });
  }
  return next();
};

async function getCreds(userId) {
  if (!USER_RE.test(String(userId || ''))) {
    return null;
  }
  const doc = await col().findOne({ _id: String(userId) });
  if (!doc || !doc.tokenEnc) {
    return null;
  }
  return { doc, token: doc.status === 'active' ? decrypt(doc.tokenEnc) : '' };
}

router.get('/credentials', orchestratorOnly, async (req, res) => {
  try {
    const c = await getCreds(req.query.user);
    res.set('Cache-Control', 'no-store');
    if (!c) {
      return res.status(404).json({ error: 'cloudflare_not_connected', message: 'Cloudflare non connecté.' });
    }
    if (!c.token) {
      return res.status(401).json({
        error: 'cloudflare_token_invalid',
        reconnect: true,
        message: 'Le jeton Cloudflare est invalide ou révoqué. Reconnecte ton compte Cloudflare.',
      });
    }
    return res.json({ account_id: c.doc.accountId, token: c.token });
  } catch (err) {
    logger.error('[cloudflare-link] lecture des identifiants impossible');
    return res.status(500).json({ error: 'erreur interne' });
  }
});

const projectName = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58)
    .replace(/-+$/g, '');

router.post('/pages/project', orchestratorOnly, async (req, res) => {
  const b = req.body || {};
  const name = projectName(b.name || b.repo);
  const owner = String(b.owner || '');
  const repo = String(b.repo || '');
  const branch = String(b.production_branch || 'main');
  if (!name || !OWNER_RE.test(owner) || !OWNER_RE.test(repo) || !OWNER_RE.test(branch)) {
    return res.status(400).json({ error: 'paramètres invalides (name, owner, repo)' });
  }
  try {
    const c = await getCreds(b.user);
    if (!c) {
      return res.status(404).json({ error: 'cloudflare_not_connected', message: 'Cloudflare non connecté.' });
    }
    if (!c.token) {
      return res.status(401).json({ error: 'cloudflare_token_invalid', reconnect: true, message: 'Reconnecte ton compte Cloudflare.' });
    }
    const accountId = c.doc.accountId;
    const payload = {
      name,
      production_branch: branch,
      build_config: {
        build_command: String(b.build_command || 'npm run build'),
        destination_dir: String(b.destination_dir || 'dist'),
        root_dir: String(b.root_dir || ''),
      },
      source: {
        type: 'github',
        config: {
          owner,
          repo_name: repo,
          production_branch: branch,
          pr_comments_enabled: true,
          deployments_enabled: true,
          production_deployments_enabled: true,
          preview_deployment_setting: 'all',
        },
      },
    };
    const r = await cf('POST', `/accounts/${accountId}/pages/projects`, c.token, payload, 'acct:' + accountId);
    if (r.status === 200 && r.body.success) {
      const project = r.body.result || {};
      // Premier déploiement (au mieux) ; sinon le prochain git push déclenche le build.
      let started = false;
      try {
        const fd = new FormData();
        fd.append('branch', branch);
        const d = await cf('POST', `/accounts/${accountId}/pages/projects/${name}/deployments`, c.token, fd, 'acct:' + accountId);
        started = d.status === 200;
      } catch (e) {
        started = false;
      }
      return res.json({
        project: name,
        url: `https://${project.subdomain || name + '.pages.dev'}`,
        auto_deploy_on_push: true,
        first_build_started: started,
      });
    }
    if (r.status === 401 || r.status === 403 || r.status === 429) {
      return cfFail(res, String(b.user), r);
    }
    const msg = firstError(r);
    const githubIssue = /github|repository|repo/i.test(msg);
    return res.status(r.status >= 400 && r.status < 600 ? r.status : 502).json({
      error: githubIssue ? 'github_app_missing' : 'cloudflare_error',
      message: githubIssue
        ? 'Cloudflare Pages n\'a pas accès à ce dépôt GitHub. Autorise l\'application Cloudflare Pages sur GitHub (une seule fois), puis réessaie.'
        : msg,
      detail: msg,
      authorize_url: githubIssue ? DASH_URL : undefined,
    });
  } catch (err) {
    logger.warn(`[cloudflare-link] création du projet impossible : ${err && err.message ? err.message : 'erreur'}`);
    return res.status(502).json({ error: 'cloudflare_error', message: 'Cloudflare injoignable.' });
  }
});

module.exports = router;
