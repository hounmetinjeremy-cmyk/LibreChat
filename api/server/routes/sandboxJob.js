/**
 * Suivi en direct d'une tâche du terminal (route /api/sandbox-job/:id).
 * L'interface (panneau sous le message) l'interroge toutes les quelques secondes ; la route
 * demande les infos à l'orchestrateur avec l'identité de l'utilisateur connecté (un utilisateur
 * ne voit que ses propres tâches). Variables Fly : ORCHESTRATOR_SECRET et SANDBOX_MCP_URL
 * (l'adresse de l'orchestrateur, avec ou sans /mcp à la fin).
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
