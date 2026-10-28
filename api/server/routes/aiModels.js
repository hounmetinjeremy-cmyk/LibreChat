/**
 * Modèles « Aube » et « Soleil » réglés depuis la page admin (/admin-config).
 * - Pour chacun : fournisseur (DeepSeek ou Gemini), vrai modèle et clé, enregistrés chiffrés en base.
 * - Route interne /ai-proxy/v1 : LibreChat l'appelle sur le serveur lui-même (127.0.0.1), elle lit
 *   la config, lit les images/PDF avec Gemini si besoin, puis transmet au bon fournisseur.
 * - Les utilisateurs ne voient que « Aube » et « Soleil », jamais le fournisseur ni la clé.
 */
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const requireJwtAuth = require('../middleware/requireJwtAuth');

const ROLES = ['aube', 'soleil'];
const LABELS = { aube: 'Aube', soleil: 'Soleil' };
const PROVIDERS = {
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};
const DEFAULTS = {
  aube: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  soleil: { provider: 'deepseek', model: 'deepseek-v4-pro' },
};
const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';
const GEMINI_NATIVE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DOC_ID = 'models';
const MAX_KEY_LENGTH = 600;
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;

const IMAGE_PROMPT =
  "Tu es les yeux d'un assistant qui ne peut pas voir. Décris cette image de façon précise et complète : " +
  'personnes, objets, scène, couleurs, disposition. Retranscris fidèlement tout le texte visible, ' +
  'les tableaux et les chiffres. Réponds en français, sans introduction.';
const DOC_PROMPT =
  'Transcris l\'intégralité de ce document en texte (Markdown), en conservant titres, listes et tableaux. ' +
  'Si une page est un scan ou une image, retranscris le texte lu et décris brièvement les schémas. ' +
  'Ne résume pas. Réponds sans introduction.';

const run = (fn) => (typeof runAsSystem === 'function' ? runAsSystem(fn) : fn());

/* ---------- stockage chiffré (même base et même chiffrement que adminKeys.js) ---------- */

const schema = new mongoose.Schema(
  { _id: String, value: String, updatedAt: Date },
  { collection: 'adminkeys', versionKey: false },
);
const AdminKey = mongoose.models.AdminKey || mongoose.model('AdminKey', schema);

function cipherKey() {
  const secret = process.env.CREDS_KEY || process.env.JWT_SECRET || '';
  if (!secret) {
    throw new Error('CREDS_KEY ou JWT_SECRET manquant : impossible de chiffrer les clés.');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(stored) {
  const [iv, tag, enc] = stored.split('.').map((x) => Buffer.from(x, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

let cache = null;
let cacheAt = 0;

/** Relit la config en base (cache de 15 s : plusieurs machines Fly restent synchronisées). */
async function loadConfig(force) {
  if (!force && cache && Date.now() - cacheAt < 15000) {
    return cache;
  }
  let cfg = {};
  try {
    const doc = await run(async () => await AdminKey.findById(DOC_ID).lean());
    if (doc && doc.value) {
      cfg = JSON.parse(decrypt(doc.value));
    }
  } catch (err) {
    logger.warn('[aiModels] configuration illisible (CREDS_KEY changé ?)');
  }
  cache = cfg;
  cacheAt = Date.now();
  return cfg;
}

async function saveConfig(cfg) {
  await run(
    async () =>
      await AdminKey.updateOne(
        { _id: DOC_ID },
        { $set: { value: encrypt(JSON.stringify(cfg)), updatedAt: new Date() } },
        { upsert: true },
      ),
  );
  cache = cfg;
  cacheAt = Date.now();
}

const real = (v) => (v && v !== 'user_provided' ? v : '');

/** Anciennes clés (page Clés API d'avant, ou secrets Fly) : servent de secours tant que rien n'est saisi. */
function fallbackKeys() {
  const pair = (process.env.JEREMY_API_KEY || '').split(',').map((s) => s.trim());
  return {
    deepseek: real(pair[0]),
    gemini: real(process.env.GOOGLE_KEY) || real(pair[1]),
  };
}

function resolveRole(cfg, role) {
  const c = cfg[role] || {};
  const provider = PROVIDERS[c.provider] ? c.provider : DEFAULTS[role].provider;
  const model = c.model || (provider === DEFAULTS[role].provider ? DEFAULTS[role].model : '');
  const key = c.key || fallbackKeys()[provider] || '';
  return { provider, model, key };
}

function resolveVision(cfg) {
  const v = cfg.vision || {};
  const model = v.model || DEFAULT_VISION_MODEL;
  let key = v.key || '';
  if (!key) {
    for (const role of ROLES) {
      const r = resolveRole(cfg, role);
      if (r.provider === 'gemini' && r.key) {
        key = r.key;
        break;
      }
    }
  }
  if (!key) {
    key = fallbackKeys().gemini;
  }
  return { key, model };
}

/* ---------- lecture des images et PDF (par Gemini) ---------- */

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const described = new Map();

function readAttachment(part) {
  if (part && part.type === 'image_url') {
    const u = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
    if (!u) {
      return null;
    }
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(u);
    if (!m) {
      return null;
    }
    const base64 = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString('base64');
    return { mime: m[1] || 'image/png', base64, id: hash(base64), kind: 'image' };
  }
  if (part && (part.type === 'file' || part.type === 'input_file')) {
    const f = part.file || part;
    const data = f.file_data || f.data;
    if (!data) {
      return null;
    }
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(data);
    const base64 = m ? m[3] : data;
    return {
      mime: (m && m[1]) || f.mime_type || 'application/pdf',
      base64,
      id: hash(base64),
      kind: 'document',
      filename: f.filename || 'document',
    };
  }
  return null;
}

async function askGemini(key, model, att) {
  const prompt = att.kind === 'image' ? IMAGE_PROMPT : DOC_PROMPT;
  const r = await fetch(`${GEMINI_NATIVE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ inlineData: { mimeType: att.mime, data: att.base64 } }, { text: prompt }] },
      ],
    }),
  });
  if (!r.ok) {
    throw new Error(`Gemini a répondu ${r.status} : ${(await r.text()).slice(0, 300)}`);
  }
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) {
    throw new Error('Gemini a renvoyé une réponse vide');
  }
  return text;
}

async function describePart(part, vision) {
  const att = readAttachment(part);
  if (!att) {
    return null;
  }
  const label = att.kind === 'image' ? 'Image jointe' : `Document « ${att.filename} »`;
  if (!vision.key) {
    return `[${label} : non lue, aucune clé Gemini enregistrée dans la page admin]`;
  }
  const cacheKey = `${att.kind}/${vision.model}/${att.id}`;
  let text = described.get(cacheKey);
  if (!text) {
    try {
      text = await askGemini(vision.key, vision.model, att);
    } catch (e) {
      return `[${label} : lecture impossible. ${e.message}]`;
    }
    if (described.size > 200) {
      described.delete(described.keys().next().value);
    }
    described.set(cacheKey, text);
  }
  return `[${label} — lu par Gemini]\n${text}`;
}

async function convertMessages(messages, vision) {
  if (!Array.isArray(messages)) {
    return messages;
  }
  const out = [];
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const pieces = await Promise.all(
      msg.content.map(async (part) => {
        if (part && part.type === 'text') {
          return part.text || '';
        }
        const d = await describePart(part, vision);
        return d === null ? '' : d;
      }),
    );
    out.push({ ...msg, content: pieces.filter(Boolean).join('\n\n') });
  }
  return out;
}

/* ---------- route interne /ai-proxy ---------- */

const err = (message) => ({ error: { message } });

/** Accepte uniquement les appels venant du serveur lui-même (jamais depuis Internet). */
function isInternal(req) {
  const addr = (req.socket && req.socket.remoteAddress) || '';
  const loopback = addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
  return loopback && !req.headers['x-forwarded-for'];
}

async function handleChat(req, res) {
  if (!isInternal(req)) {
    return res.status(403).json(err('Accès refusé'));
  }
  try {
    const body = req.body || {};
    const asked = String(body.model || '').trim().toLowerCase();
    const role = ROLES.includes(asked) ? asked : 'aube';
    const cfg = await loadConfig();
    const target = resolveRole(cfg, role);
    if (!target.key) {
      return res
        .status(401)
        .json(err(`Clé manquante pour « ${LABELS[role]} » : à renseigner dans la page admin « Clés API ».`));
    }
    if (!target.model) {
      return res
        .status(400)
        .json(err(`Modèle manquant pour « ${LABELS[role]} » : à renseigner dans la page admin « Clés API ».`));
    }
    body.model = target.model;
    // Précaution Gemini : une limite de sortie très basse (1200) peut couper ou vider la réponse
    // des modèles qui « réfléchissent » avant de répondre.
    if (target.provider === 'gemini' && typeof body.max_tokens === 'number') {
      body.max_tokens = Math.max(body.max_tokens, 4096);
    }
    body.messages = await convertMessages(body.messages, resolveVision(cfg));

    const ctrl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        ctrl.abort();
      }
    });
    const up = await fetch(PROVIDERS[target.provider], {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    res.status(up.status);
    res.set('content-type', up.headers.get('content-type') || 'application/json');
    if (!up.body) {
      return res.end();
    }
    Readable.fromWeb(up.body)
      .on('error', () => res.end())
      .pipe(res);
  } catch (e) {
    logger.error('[aiModels] échec de la requête', e);
    if (!res.headersSent) {
      res.status(502).json(err('Le fournisseur du modèle est injoignable.'));
    } else {
      res.end();
    }
  }
}

const proxyRouter = express.Router();
proxyRouter.post('/ai-proxy/v1/chat/completions', express.json({ limit: '60mb' }), handleChat);
proxyRouter.get('/ai-proxy/v1/models', (req, res) => {
  if (!isInternal(req)) {
    return res.status(403).json(err('Accès refusé'));
  }
  return res.json({
    object: 'list',
    data: ROLES.map((r) => ({ id: LABELS[r], object: 'model', owned_by: 'serveur' })),
  });
});

/* ---------- API de la page admin ---------- */

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Réservé à l’administrateur' });
  }
  return next();
}

const hintOf = (v) => (v ? `••••${v.slice(-4)}` : '');

function describeConfig(cfg) {
  const fb = fallbackKeys();
  const out = {};
  for (const role of ROLES) {
    const r = resolveRole(cfg, role);
    const stored = (cfg[role] && cfg[role].key) || '';
    out[role] = {
      provider: r.provider,
      model: r.model,
      set: Boolean(stored),
      hint: hintOf(stored),
      viaServer: !stored && Boolean(fb[r.provider]),
    };
  }
  const v = cfg.vision || {};
  out.vision = {
    model: v.model || DEFAULT_VISION_MODEL,
    set: Boolean(v.key),
    hint: hintOf(v.key),
    viaServer: !v.key && Boolean(resolveVision(cfg).key),
  };
  return out;
}

const adminRouter = express.Router();

adminRouter.get('/api/admin-models', requireJwtAuth, requireAdmin, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(describeConfig(await loadConfig(true)));
});

adminRouter.put('/api/admin-models', requireJwtAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const cfg = JSON.parse(JSON.stringify(await loadConfig(true)));
    const apply = (name, input, withProvider) => {
      if (!input || typeof input !== 'object') {
        return null;
      }
      const cur = { ...(cfg[name] || {}) };
      if (withProvider && input.provider !== undefined) {
        if (!PROVIDERS[input.provider]) {
          return 'Fournisseur inconnu';
        }
        cur.provider = input.provider;
      }
      if (typeof input.model === 'string' && input.model.trim()) {
        if (!MODEL_RE.test(input.model.trim())) {
          return `Nom de modèle invalide pour « ${name} »`;
        }
        cur.model = input.model.trim();
      }
      if (input.key === null) {
        delete cur.key;
      } else if (typeof input.key === 'string' && input.key.trim()) {
        if (input.key.trim().length > MAX_KEY_LENGTH) {
          return `Clé « ${name} » trop longue`;
        }
        cur.key = input.key.trim();
      }
      cfg[name] = cur;
      return null;
    };
    for (const role of ROLES) {
      const problem = apply(role, body[role], true);
      if (problem) {
        return res.status(400).json({ message: problem });
      }
    }
    const problem = apply('vision', body.vision, false);
    if (problem) {
      return res.status(400).json({ message: problem });
    }
    await saveConfig(cfg);
    res.set('Cache-Control', 'no-store');
    return res.json(describeConfig(cfg));
  } catch (e) {
    logger.error('[aiModels] enregistrement impossible', e);
    return res.status(500).json({ message: 'Enregistrement impossible' });
  }
});

module.exports = { proxyRouter, adminRouter };
