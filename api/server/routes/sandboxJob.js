/**
 * Suivi en direct d'une tâche du terminal (route /api/sandbox-job/:id) et solde de tokens
 * de l'utilisateur (route /api/sandbox-job/quota).
 * L'interface (panneau sous le message, écran « Tokens » du menu +) interroge ces routes ; elles
 * demandent les infos à l'orchestrateur avec l'identité de l'utilisateur connecté (un utilisateur
 * ne voit que ses propres tâches et son propre solde). Variables Fly : ORCHESTRATOR_SECRET et
 * SANDBOX_MCP_URL (l'adresse de l'orchestrateur, avec ou sans /mcp à la fin).
 * SANDBOX_DAILY_TOKENS (facultatif) : limite quotidienne affichée, 2 000 000 par défaut.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const ID_RE = /^[a-f0-9]{12}$/;

const orchestratorBase = () =>
  String(process.env.SANDBOX_ORCH_URL || process.env.SANDBOX_MCP_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/mcp$/, '');

const dailyLimit = () => Number(process.env.SANDBOX_DAILY_TOKENS) || 2000000;

/** Solde du jour : appelle l'outil my_quota de l'orchestrateur pour l'utilisateur connecté. */
router.get('/quota', requireJwtAuth, async (req, res) => {
  const secret = process.env.ORCHESTRATOR_SECRET || '';
  const base = orchestratorBase();
  if (!secret || !base) {
    return res.status(503).json({ error: 'solde indisponible' });
  }
  try {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-User-Id': String(req.user.id),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'my_quota', arguments: {} },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await r.text();
    if (!r.ok) {
      logger.warn(`[sandbox-quota] orchestrateur : HTTP ${r.status}`);
      return res.status(502).json({ error: 'orchestrateur indisponible' });
    }
    const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
    const msg = JSON.parse(dataLine ? dataLine.slice(5).trim() : raw);
    const q = JSON.parse(msg?.result?.content?.[0]?.text || '{}');
    const remaining = Math.max(0, Number(q.tokens_restants) || 0);
    const limit = Math.max(dailyLimit(), remaining);
    return res
      .status(200)
      .set({ 'Cache-Control': 'no-store' })
      .json({
        remaining,
        limit,
        used: limit - remaining,
        percent: Math.round((remaining / limit) * 100),
        jobs_remaining: Number(q.jobs_restants) || 0,
      });
  } catch (err) {
    logger.warn(`[sandbox-quota] lecture impossible : ${err?.message || 'erreur'}`);
    return res.status(502).json({ error: 'orchestrateur injoignable' });
  }
});

router.get('/:id', requireJwtAuth, async (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: 'job invalide' });
  }
  const secret = process.env.ORCHESTRATOR_SECRET || '';
  const base = orchestratorBase();
  if (!secret || !base) {
    return res.status(503).json({ error: 'suivi indisponible' });
  }
  try {
    const r = await fetch(`${base}/jobs/${id}`, {
      headers: { Authorization: `Bearer ${secret}`, 'X-User-Id': String(req.user.id) },
      signal: AbortSignal.timeout(10000),
    });
    const body = await r.text();
    return res
      .status(r.status)
      .set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' })
      .send(body);
  } catch (err) {
    logger.warn(`[sandbox-job] lecture impossible : ${err?.message || 'erreur'}`);
    return res.status(502).json({ error: 'orchestrateur injoignable' });
  }
});

module.exports = router;
