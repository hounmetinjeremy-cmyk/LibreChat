/**
 * Consommation RÉELLE par utilisateur, lue dans la réponse d'OpenRouter.
 * Chaque réponse du fournisseur contient un objet `usage` avec les tokens (entrée, sortie, cache) et `cost`,
 * le montant réellement facturé en dollars. Le proxy /ai-proxy appelle record() à la fin de chaque réponse :
 * on additionne par jour et par utilisateur dans la collection MongoDB « or_usage » (un document par jour et par
 * utilisateur, y compris le compte ADMIN).
 *
 * Routes :
 *   GET /api/or-usage/me   la consommation de l'utilisateur connecté (aujourd'hui, 7 jours, 30 jours)
 *   GET /api/or-usage/all  ADMIN seulement : une ligne par utilisateur, et le solde du compte OpenRouter si le
 *                          secret OPENROUTER_MANAGEMENT_KEY est défini (clé de management, lecture seule ici)
 * Jamais bloquant : une erreur d'enregistrement est ignorée, le chat n'est jamais ralenti.
 */
const express = require('express');
const mongoose = require('mongoose');
const requireJwtAuth = require('../middleware/requireJwtAuth');

const router = express.Router();

const col = () => mongoose.connection.collection('or_usage');
const dayOf = (d) => (d || new Date()).toISOString().slice(0, 10);
const daysAgo = (n) => dayOf(new Date(Date.now() - n * 86400000));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Enregistre une réponse du fournisseur : appelé par le proxy, sans attendre. */
function record(user, usage) {
  try {
    if (!user || !usage || typeof usage !== 'object') {
      return;
    }
    const details = usage.prompt_tokens_details || {};
    const day = dayOf();
    const inc = {
      requests: 1,
      prompt: num(usage.prompt_tokens),
      completion: num(usage.completion_tokens),
      cached: num(details.cached_tokens) || num(usage.prompt_cache_hit_tokens),
      cost: num(usage.cost),
      costed: usage.cost != null ? 1 : 0,
    };
    col()
      .updateOne({ _id: `${day}:${user}` }, { $inc: inc, $setOnInsert: { day, user } }, { upsert: true })
      .catch(() => {});
  } catch (e) {
    /* enregistrement ignoré */
  }
}

const empty = () => ({ requests: 0, prompt: 0, completion: 0, cached: 0, cost: 0, costed: 0 });
const add = (a, d) => {
  for (const k of Object.keys(a)) {
    a[k] += num(d[k]);
  }
  return a;
};

router.get('/api/or-usage/me', requireJwtAuth, async (req, res) => {
  try {
    const user = String(req.user.id || req.user._id);
    const docs = await col()
      .find({ user, day: { $gte: daysAgo(29) } })
      .toArray();
    const today = dayOf();
    const from7 = daysAgo(6);
    const out = { today: empty(), last7: empty(), last30: empty(), admin: req.user.role === 'ADMIN' };
    for (const d of docs) {
      add(out.last30, d);
      if (d.day >= from7) {
        add(out.last7, d);
      }
      if (d.day === today) {
        add(out.today, d);
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'indisponible' });
  }
});

let creditsCache = { at: 0, value: null };

/** Solde du compte OpenRouter (clé de management). null si la clé est absente ou si OpenRouter ne répond pas. */
async function openRouterCredits() {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) {
    return null;
  }
  if (Date.now() - creditsCache.at < 60000) {
    return creditsCache.value;
  }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      return null;
    }
    const j = await r.json();
    const total = Number(j && j.data && j.data.total_credits);
    const used = Number(j && j.data && j.data.total_usage);
    const value =
      Number.isFinite(total) && Number.isFinite(used) ? { total, used, remaining: total - used } : null;
    creditsCache = { at: Date.now(), value };
    return value;
  } catch (e) {
    return null;
  }
}

router.get('/api/or-usage/all', requireJwtAuth, async (req, res) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'réservé à l\'administrateur' });
  }
  try {
    const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days)) || 7));
    const docs = await col()
      .find({ day: { $gte: daysAgo(days - 1) } })
      .toArray();
    const byUser = new Map();
    const total = empty();
    for (const d of docs) {
      if (!byUser.has(d.user)) {
        byUser.set(d.user, empty());
      }
      add(byUser.get(d.user), d);
      add(total, d);
    }
    const ids = [...byUser.keys()].filter((id) => mongoose.Types.ObjectId.isValid(id));
    const emails = new Map();
    try {
      const User = mongoose.models.User;
      if (User && ids.length) {
        const rows = await User.find({ _id: { $in: ids } }, 'email name').lean();
        rows.forEach((u) => emails.set(String(u._id), u.email || u.name || ''));
      }
    } catch (e) {
      /* e-mails indisponibles : on affiche l'identifiant */
    }
    const users = [...byUser.entries()]
      .map(([user, v]) => ({ user, email: emails.get(user) || '', ...v }))
      .sort((a, b) => b.cost - a.cost);
    res.json({ days, users, total, credits: await openRouterCredits() });
  } catch (e) {
    res.status(500).json({ error: 'indisponible' });
  }
});

module.exports = { router, record };
