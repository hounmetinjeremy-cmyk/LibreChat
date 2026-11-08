'use strict';
/**
 * Allège l'historique envoyé au modèle (Aube, Soleil) à chaque étape d'une tâche.
 *
 * Pourquoi : dans une tâche de plusieurs dizaines d'étapes (build, vérifications...), l'historique complet est renvoyé
 * à CHAQUE appel. Les anciennes sorties d'outils (terminal, MCP) en sont la plus grosse part et ne servent plus.
 *
 * Règles :
 *  - les N derniers résultats d'outils restent intacts (N = HISTORY_KEEP_TOOL_RESULTS, 6 par défaut) ;
 *  - la limite avance PAR PALIERS de HISTORY_TRIM_STEP résultats (8 par défaut), pas à chaque appel : le début de
 *    l'historique reste ainsi identique d'un appel à l'autre, ce qui laisse le cache du fournisseur (DeepSeek, Gemini)
 *    fonctionner. Il ne s'invalide qu'à chaque palier. Entre deux paliers, 6 à 13 résultats restent intacts ;
 *  - un résultat plus ancien et plus long que HISTORY_STUB_MIN_CHARS (600 par défaut) est réduit à son début et sa fin,
 *    avec une note qui dit comment retrouver le détail ;
 *  - messages de l'utilisateur, textes de l'assistant et appels d'outils (donc le code écrit par l'IA) ne sont JAMAIS
 *    modifiés : le modèle ne doit pas prendre l'habitude d'abréger ce qu'il écrit ;
 *  - HISTORY_TRIM=off désactive tout.
 */
const { logger } = require('@librechat/data-schemas');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

function stubText(text, minChars) {
  const t = String(text);
  if (t.length <= minChars) {
    return t;
  }
  const omitted = t.length - 300;
  return (
    `${t.slice(0, 150).trim()}\n` +
    `[… ${omitted} caractères d'une ancienne sortie retirés pour économiser des tokens : ` +
    `relancer la commande ou relire le fichier si le détail est nécessaire …]\n` +
    `${t.slice(-150).trim()}`
  );
}

function stubContent(content, minChars) {
  if (typeof content === 'string') {
    return stubText(content, minChars);
  }
  if (Array.isArray(content)) {
    return content.map((part) =>
      part && part.type === 'text' && typeof part.text === 'string'
        ? { ...part, text: stubText(part.text, minChars) }
        : part,
    );
  }
  return content;
}

const sizeOf = (content) =>
  typeof content === 'string'
    ? content.length
    : Array.isArray(content)
      ? content.reduce((n, p) => n + (p && typeof p.text === 'string' ? p.text.length : 0), 0)
      : 0;

function trimHistory(messages) {
  try {
    if (process.env.HISTORY_TRIM === 'off' || !Array.isArray(messages)) {
      return messages;
    }
    const keep = num(process.env.HISTORY_KEEP_TOOL_RESULTS, 6);
    const minChars = num(process.env.HISTORY_STUB_MIN_CHARS, 600);
    const toolIdx = [];
    messages.forEach((m, i) => {
      if (m && m.role === 'tool') {
        toolIdx.push(i);
      }
    });
    const step = Math.max(1, Math.floor(num(process.env.HISTORY_TRIM_STEP, 8)));
    const extra = toolIdx.length - keep;
    const stubCount = extra > 0 ? Math.floor(extra / step) * step : 0;
    const old = new Set(toolIdx.slice(0, stubCount));
    if (!old.size) {
      return messages;
    }
    let touched = 0;
    let saved = 0;
    const out = messages.map((m, i) => {
      if (!old.has(i)) {
        return m;
      }
      const content = stubContent(m.content, minChars);
      const delta = sizeOf(m.content) - sizeOf(content);
      if (delta > 0) {
        touched += 1;
        saved += delta;
      }
      return { ...m, content };
    });
    if (touched) {
      logger.info(`[aiModels] historique allégé : ${touched} anciennes sorties réduites, environ ${Math.round(saved / 4)} tokens en moins`);
    }
    return out;
  } catch (e) {
    return messages;
  }
}

module.exports = { trimHistory, stubText };
