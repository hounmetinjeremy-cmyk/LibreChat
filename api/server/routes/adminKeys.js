/**
 * Clés des fournisseurs (DeepSeek, Gemini, Modal, vidéo) enregistrées par l'administrateur.
 * - Page de configuration : /admin-config (réservée au compte ADMIN)
 * - API : GET/PUT /api/admin-keys
 * Les clés sont chiffrées en base (AES-256-GCM) et appliquées aux variables d'environnement
 * utilisées par librechat.yaml (JEREMY_API_KEY, JEREMY_GPU_API_KEY, VIDEO_API_KEY) et GOOGLE_KEY.
 * Les utilisateurs n'ont donc aucune clé à saisir.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const requireJwtAuth = require('../middleware/requireJwtAuth');

const router = express.Router();

const FIELDS = ['deepseek', 'gemini', 'modal', 'video'];
const ENV_NAMES = ['GOOGLE_KEY', 'JEREMY_API_KEY', 'JEREMY_GPU_API_KEY', 'VIDEO_API_KEY'];
const MAX_KEY_LENGTH = 600;

const run = (fn) => (typeof runAsSystem === 'function' ? runAsSystem(fn) : fn());

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

async function loadAll() {
  const docs = await run(async () => await AdminKey.find({}).lean());
  const out = {};
  for (const doc of docs) {
    try {
      out[doc._id] = decrypt(doc.value);
    } catch (err) {
      logger.warn(`[adminKeys] clé « ${doc._id} » illisible (CREDS_KEY changée ?)`);
    }
  }
  return out;
}

let originalEnv = null;

/** Applique les clés enregistrées aux variables d'environnement (sinon garde les secrets Fly). */
function applyToEnv(values) {
  if (originalEnv == null) {
    originalEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  }
  const wanted = {
    GOOGLE_KEY: values.gemini,
    JEREMY_API_KEY: values.deepseek && values.gemini ? `${values.deepseek},${values.gemini}` : undefined,
    JEREMY_GPU_API_KEY: values.modal,
    VIDEO_API_KEY: values.video,
  };
  for (const name of ENV_NAMES) {
    const value = wanted[name] ?? originalEnv[name];
    if (value == null || value === '') {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

async function applyStoredKeys() {
  try {
    applyToEnv(await loadAll());
    logger.info('[adminKeys] clés administrateur appliquées');
  } catch (err) {
    logger.error('[adminKeys] échec du chargement des clés', err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Réservé à l’administrateur' });
  }
  return next();
}

function describe(values) {
  const out = {};
  for (const field of FIELDS) {
    const v = values[field];
    out[field] = v ? { set: true, hint: `••••${v.slice(-4)}` } : { set: false, hint: '' };
  }
  return out;
}

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'adminConfig', name), 'utf8');
const sendAsset = (type, name) => (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.type(type).send(read(name));
};

router.get('/admin-config', sendAsset('html', 'index.html'));
router.get('/admin-config.js', sendAsset('js', 'admin-config.js'));
router.get('/admin-config.css', sendAsset('css', 'admin-config.css'));

router.get('/api/admin-keys', requireJwtAuth, requireAdmin, async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(describe(await loadAll()));
  } catch (err) {
    logger.error('[adminKeys] lecture impossible', err);
    res.status(500).json({ message: 'Lecture impossible' });
  }
});

router.put('/api/admin-keys', requireJwtAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body ?? {};
    for (const field of FIELDS) {
      const input = body[field];
      if (input === null) {
        await run(async () => await AdminKey.deleteOne({ _id: field }));
        continue;
      }
      if (typeof input !== 'string') {
        continue;
      }
      const value = input.trim();
      if (value === '') {
        continue;
      }
      if (value.length > MAX_KEY_LENGTH) {
        return res.status(400).json({ message: `Clé « ${field} » trop longue` });
      }
      await run(
        async () =>
          await AdminKey.updateOne(
            { _id: field },
            { $set: { value: encrypt(value), updatedAt: new Date() } },
            { upsert: true },
          ),
      );
    }
    const values = await loadAll();
    applyToEnv(values);
    res.set('Cache-Control', 'no-store');
    res.json(describe(values));
  } catch (err) {
    logger.error('[adminKeys] enregistrement impossible', err);
    res.status(500).json({ message: 'Enregistrement impossible' });
  }
});

module.exports = { router, applyStoredKeys };
