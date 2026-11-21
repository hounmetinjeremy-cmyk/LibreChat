'use strict';
/**
 * Expert d'appoint : quand l'agent du chat patine (voir loopGuard.js), un modèle plus fort regarde ses derniers essais
 * et lui donne des instructions précises (cause probable, commandes exactes à lancer dans le terminal, vérification).
 * L'agent garde son terminal et applique ces instructions : même un modèle peu performant peut alors s'en sortir.
 * L'expert n'est consulté QUE lorsque l'agent est bloqué (jamais à chaque message), avec un contexte très court :
 * l'objectif de l'utilisateur et les derniers appels d'outils tronqués, sans mots de passe ni clés (masqués).
 *
 * Réglages (secrets Fly) :
 *   EXPERT_HELP=on               ACTIVE l'expert (désactivé par défaut : il utilise un modèle payant)
 *   EXPERT_MODEL                 modèle de l'expert, « éditeur/modèle » OpenRouter (défaut anthropic/claude-sonnet-5.5)
 *   EXPERT_MAX_PER_CONV=2        consultations au maximum par conversation
 *   EXPERT_MAX_PER_DAY=100       consultations au maximum par jour, tous utilisateurs confondus
 * Jamais bloquant : toute erreur (clé absente, limite atteinte, délai dépassé) renvoie null et le garde-fou simple s'applique.
 */
const crypto = require('crypto');
const { collectCalls } = require('./loopGuard');

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
const perConv = new Map();
const perDay = { day: '', n: 0 };

const SECRETS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|token|secret|passw(or)?d|mot de passe)\b["'\s:=]+[^\s"',;]{6,}/gi,
];
const redact = (s) => SECRETS.reduce((t, re) => t.replace(re, '[masqué]'), String(s == null ? '' : s));
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ') : '';

function conversationKey(messages) {
  const first = (messages || []).find((m) => m && m.role === 'user');
  return crypto.createHash('sha1').update(textOf(first && first.content).slice(0, 400)).digest('hex').slice(0, 16);
}

function allowed(key) {
  const today = new Date().toISOString().slice(0, 10);
  if (perDay.day !== today) {
    perDay.day = today;
    perDay.n = 0;
  }
  const maxDay = Math.max(1, Math.floor(Number(process.env.EXPERT_MAX_PER_DAY)) || 100);
  const maxConv = Math.max(1, Math.floor(Number(process.env.EXPERT_MAX_PER_CONV)) || 2);
  return perDay.n < maxDay && (perConv.get(key) || 0) < maxConv;
}

function remember(key) {
  perDay.n += 1;
  perConv.set(key, (perConv.get(key) || 0) + 1);
  if (perConv.size > 500) {
    perConv.delete(perConv.keys().next().value);
  }
}

/** Texte envoyé à l'expert : objectif + derniers essais de l'agent, tronqués et sans secrets. */
function buildPrompt(hit, messages) {
  const users = (messages || []).filter((m) => m && m.role === 'user' && !/^\[Garde-fou\]/.test(textOf(m.content)));
  const goal = clip(textOf(users[users.length - 1] && users[users.length - 1].content), 600);
  const calls = collectCalls(messages || []).slice(-6);
  const tries = calls
    .map((c, i) => `${i + 1}. ${c.name}(${clip(redact(c.args), 300)}) → ${clip(redact(c.result), 500)}`)
    .join('\n');
  return (
    `Demande de l'utilisateur : ${redact(goal)}\n\n` +
    `Blocage : l'outil « ${hit.name} » — ${hit.reason}.\n\nDerniers essais de l'agent :\n${tries}`
  );
}

const SYSTEM =
  "Tu es un expert de dépannage. Un agent IA moins performant est bloqué sur une tâche dans un terminal Linux jetable " +
  "(Node, Python, git disponibles). À partir de ses derniers essais, réponds en français, sans introduction, en 120 mots " +
  "maximum : 1) la cause probable en une phrase ; 2) les commandes EXACTES à lancer, une par ligne, dans l'ordre ; " +
  "3) comment vérifier que c'est réglé. Ne propose jamais de recommencer ce qui a déjà échoué à l'identique.";

/**
 * Interroge l'expert. Renvoie le conseil (texte court) ou null.
 * @param {{hit:{name:string,reason:string}, messages:Array, key:string, url:string}} p
 */
async function consult({ hit, messages, key, url }) {
  try {
    if (process.env.EXPERT_HELP !== 'on' || !key || !url) {
      return null;
    }
    const conv = conversationKey(messages);
    if (!allowed(conv)) {
      return null;
    }
    remember(conv);
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.EXPERT_MODEL || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(hit, messages) },
        ],
        max_tokens: 350,
        temperature: 0.2,
        stream: false,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) {
      return null;
    }
    const j = await r.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return typeof text === 'string' && text.trim() ? text.trim().slice(0, 1200) : null;
  } catch (e) {
    return null;
  }
}

module.exports = { consult, buildPrompt, redact };
