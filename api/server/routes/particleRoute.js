'use strict';
/**
 * Moteur Particle AI via OpenRouter, avec bascule automatique gratuit -> payant -> chaîne habituelle.
 *  1. particle-ai/particle-1:free   (0 $)
 *  2. particle-ai/particle-1        (payant, très bas prix) si le gratuit répond 429 (limite), 402, 404 ou 5xx
 *  3. la chaîne existante d'Aube / Soleil (DeepSeek, Gemini, OpenRouter-Relace...) si Particle échoue aussi.
 * Quand le gratuit échoue, il est mis de côté PARTICLE_FREE_COOLDOWN_MS (5 minutes par défaut) pour ne pas perdre un
 * aller-retour à chaque étape d'une tâche.
 *
 * Réglages (secrets Fly) :
 *   PARTICLE_AI=on                 active (sans lui, rien ne change)
 *   PARTICLE_ROLES=aube            rôles concernés, séparés par des virgules (aube,soleil)
 *   PARTICLE_FREE_COOLDOWN_MS=300000
 * La clé est celle d'OpenRouter déjà configurée. Pas de routage vers un hébergeur imposé : le routage Relace est
 * réservé aux modèles DeepSeek.
 */
const FREE = 'particle-ai/particle-1:free';
const PAID = 'particle-ai/particle-1';

let freeBlockedUntil = 0;

function enabled(role) {
  if (process.env.PARTICLE_AI !== 'on') {
    return false;
  }
  return String(process.env.PARTICLE_ROLES || 'aube')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes(role);
}

/** Essais Particle à placer devant la chaîne habituelle (liste vide si désactivé ou sans clé OpenRouter). */
function front(role, key, url) {
  if (!enabled(role) || !key || !url) {
    return [];
  }
  const out = [];
  if (Date.now() >= freeBlockedUntil) {
    out.push({ provider: 'openrouter', model: FREE, key, url, noRouting: true });
  }
  out.push({ provider: 'openrouter', model: PAID, key, url, noRouting: true });
  return out;
}

/** À appeler quand un essai échoue : le gratuit est mis de côté un moment. */
function noteFailure(candidate, status) {
  if (candidate && candidate.model === FREE && status !== 200) {
    const ms = Math.max(0, Number(process.env.PARTICLE_FREE_COOLDOWN_MS)) || 300000;
    freeBlockedUntil = Date.now() + ms;
  }
}

module.exports = { front, noteFailure, enabled, FREE, PAID };
