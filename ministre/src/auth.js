// Authentification PAR UTILISATEUR pour les serveurs derrière le Ministre.
//
// Mode « coffre » (auth.type = "vault") : le jeton personnel de l'utilisateur est lu dans le coffre
// de LibreChat (ex. /api/github-link/token), avec le même secret interne que le terminal
// (ORCHESTRATOR_SECRET). L'agent ne voit jamais le jeton : seul le Ministre l'ajoute à l'appel.
// Si l'utilisateur n'est pas connecté, on fabrique un lien de connexion signé (15 min),
// identique à celui que donne déjà le terminal.
import crypto from 'node:crypto';

const USER_RE = /^[A-Za-z0-9_-]{8,64}$/;

const hmac = (env, value) =>
  crypto.createHmac('sha256', env.ORCHESTRATOR_SECRET || '').update(value).digest('hex');

const localBase = (env) => `http://127.0.0.1:${env.PORT || 3080}`;

export function connectLink(env, up, userId) {
  const base = String(env.DOMAIN_SERVER || '').replace(/\/$/, '');
  if (!base || !env.ORCHESTRATOR_SECRET || !USER_RE.test(userId || '') || !up.auth || !up.auth.startPath) {
    return '';
  }
  const exp = Date.now() + 15 * 60 * 1000;
  const q = new URLSearchParams({ u: userId, e: String(exp), s: hmac(env, `${userId}.${exp}`) });
  return `${base}${up.auth.startPath}?${q}`;
}

// Renvoie { headers } à ajouter à l'appel, ou { notConnected: true }, ou { error }.
export async function userAuth(env, up, userId) {
  if (!up.auth || up.auth.type !== 'vault') return { headers: {} };
  if (!USER_RE.test(userId || '')) return { error: 'utilisateur non identifié (en-tête X-User-Id absent)' };
  try {
    const r = await fetch(`${localBase(env)}${up.auth.tokenPath}?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.ORCHESTRATOR_SECRET || ''}` },
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 404) return { notConnected: true };
    if (!r.ok) return { error: `coffre HTTP ${r.status}` };
    const data = await r.json();
    if (!data || !data.token) return { notConnected: true };
    return { headers: { Authorization: `${up.auth.scheme || 'Bearer'} ${data.token}` } };
  } catch (e) {
    return { error: `coffre injoignable (${String((e && e.message) || e).slice(0, 60)})` };
  }
}
