'use strict';
/**
 * Détecteur anti-patinage, appliqué par le proxy /ai-proxy avant chaque envoi au modèle.
 *
 * Il lit l'historique de la conversation (appels d'outils de l'IA et leurs résultats) et repère les 3 derniers appels
 * consécutifs quand l'IA n'avance plus :
 *  - même outil, mêmes arguments ET même résultat, 3 fois de suite (elle répète exactement la même action) ;
 *  - même outil et même ERREUR en résultat, 3 fois de suite, même si les arguments changent légèrement.
 * Dans ce cas, l'outil est retiré de la liste envoyée au modèle et une consigne courte lui dit de changer de méthode
 * ou de s'arrêter et d'expliquer l'erreur. Un message normal ne reçoit rien : l'historique de l'utilisateur et le code
 * écrit par l'IA ne sont jamais modifiés. Les outils d'attente (get_job...) sont exemptés : les répéter est normal.
 * Pour le terminal (execute_command), seule la règle « même erreur » s'applique : attendre une longue commande en
 * relançant la même attente peut donner trois fois le même résultat sans que ce soit une boucle.
 *
 * Réglages : LOOP_GUARD=off désactive ; LOOP_GUARD_REPEATS=3 ; LOOP_GUARD_EXEMPT=get_job,close_session,my_quota,find_repos ;
 * LOOP_GUARD_ERROR_ONLY=execute_command (outils où seule la règle « même erreur » s'applique)
 */
const crypto = require('crypto');

const ERROR_RE =
  /\b(error|erreur|failed|failure|échec|echec|denied|refus[ée]?|not found|introuvable|invalid|invalide|exception|timed? ?out|enoent|unauthorized|forbidden)\b/i;

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('')
      : '';

function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeArgs(raw) {
  try {
    return stable(JSON.parse(raw));
  } catch (e) {
    return String(raw || '').trim();
  }
}

/** Appels d'outils dans l'ordre, avec leur résultat (undefined si le résultat n'est pas encore là). */
function collectCalls(messages) {
  const results = new Map();
  for (const m of messages) {
    if (m && m.role === 'tool' && m.tool_call_id) {
      results.set(m.tool_call_id, textOf(m.content));
    }
  }
  const calls = [];
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) {
      continue;
    }
    for (const tc of m.tool_calls) {
      const fn = tc && tc.function;
      if (!fn || typeof fn.name !== 'string') {
        continue;
      }
      calls.push({ name: fn.name, args: normalizeArgs(fn.arguments), result: results.get(tc.id) });
    }
  }
  return calls;
}

function listed(name, envName, fallback) {
  const list = String(process.env[envName] || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((e) => name === e || name.endsWith(`_${e}`) || name.includes(`${e}_mcp_`));
}

const exempt = (name) => listed(name, 'LOOP_GUARD_EXEMPT', 'get_job,close_session,my_quota,find_repos');
const errorOnly = (name) => listed(name, 'LOOP_GUARD_ERROR_ONLY', 'execute_command');

/** { name, reason } si l'IA patine, sinon null. */
function detect(messages) {
  if (!Array.isArray(messages)) {
    return null;
  }
  const n = Math.max(2, Math.floor(Number(process.env.LOOP_GUARD_REPEATS)) || 3);
  const calls = collectCalls(messages);
  if (calls.length < n) {
    return null;
  }
  const last = calls.slice(-n);
  const name = last[0].name;
  if (last.some((c) => c.name !== name || c.result === undefined) || exempt(name)) {
    return null;
  }
  const sameResult = last.every((c) => hash(c.result) === hash(last[0].result));
  if (!sameResult) {
    return null;
  }
  if (!errorOnly(name) && last.every((c) => c.args === last[0].args)) {
    return { name, reason: `mêmes arguments et même résultat ${n} fois de suite` };
  }
  if (ERROR_RE.test(last[0].result)) {
    return { name, reason: `même erreur ${n} fois de suite` };
  }
  return null;
}

/** Retire l'outil qui patine et ajoute la consigne. Renvoie { name, reason } si le garde-fou a agi, sinon null. */
function apply(body) {
  if (!body || process.env.LOOP_GUARD === 'off') {
    return null;
  }
  const hit = detect(body.messages);
  if (!hit) {
    return null;
  }
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter((t) => !(t && t.function && t.function.name === hit.name));
    if (body.tools.length === 0) {
      delete body.tools;
      delete body.tool_choice;
    }
  }
  body.messages = body.messages.concat({
    role: 'user',
    content:
      `[Garde-fou] Tu patines : l'outil « ${hit.name} » a été appelé avec ${hit.reason}, sans avancer. ` +
      `Il est retiré pour la suite. Change de méthode, ou arrête-toi : montre l'erreur exacte en une ligne ` +
      `et demande à l'utilisateur ce qu'il veut faire. Ne rappelle pas cet outil.`,
  });
  return hit;
}

module.exports = { detect, apply };
