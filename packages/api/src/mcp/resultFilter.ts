/**
 * Filtre générique appliqué à TOUS les résultats d'outils MCP (serveurs officiels
 * et personnalisés), avant qu'ils n'arrivent à l'IA. Objectif : réduire les tokens
 * sans perdre l'information utile.
 *
 * Principe « entre les deux » : l'ENVELOPPE d'un résultat (métadonnées, listes, champs techniques)
 * est réduite fortement ; le CONTENU lu (code d'un fichier, diff, sortie de commande) est protégé
 * et gardé complet jusqu'à une limite généreuse. Ce filtre ne touche jamais ce que l'IA ÉCRIT :
 * seulement ce qui lui revient.
 *
 * Réglages (variables d'environnement, toutes optionnelles) :
 * - MCP_RESULT_FILTER=false          désactive complètement le filtre
 * - MCP_RESULT_MAX_CHARS=12000       taille maximale d'un résultat texte
 * - MCP_RESULT_JSON_MAX_CHARS=1500   budget de l'ENVELOPPE d'un résultat JSON (défaut : MCP_RESULT_MAX_CHARS).
 *                                    Au-delà, le JSON est réduit étape par étape (moins d'éléments,
 *                                    textes plus courts) jusqu'à entrer dans ce budget, au lieu
 *                                    d'être coupé en plein milieu. Repère : environ 3 caractères
 *                                    par token en JSON, donc 600 = environ 200 tokens, 1500 = 500.
 * - MCP_RESULT_CONTENT_MAX_CHARS=12000  taille maximale d'un champ de CONTENU protégé (défaut :
 *                                    MCP_RESULT_MAX_STRING). Ces champs ne comptent pas dans le budget
 *                                    de l'enveloppe et ne sont pas réduits par les étapes de réduction.
 * - MCP_RESULT_CONTENT_KEYS=a,b      noms de champs de contenu en plus de ceux par défaut
 *                                    (content, text, body, code, diff, patch, source, stdout, stderr, output, log, logs)
 * - MCP_RESULT_MAX_ARRAY_ITEMS=25    nombre maximal d'éléments gardés par liste
 * - MCP_RESULT_MAX_STRING=2000       taille maximale d'une chaîne ordinaire dans un JSON
 * - MCP_RESULT_DROP_KEYS=a,b,c       clés supplémentaires à supprimer
 * - MCP_RESULT_KEEP_KEYS=x,y         clés à toujours conserver
 */

const DEFAULT_MAX_CHARS = 12000;
const DEFAULT_MAX_ARRAY_ITEMS = 25;
const DEFAULT_MAX_STRING = 2000;
const MAX_DEPTH = 10;

/** Clés techniques très verbeuses et rarement utiles à l'IA (ex. API GitHub). */
const DEFAULT_DROP_KEYS = new Set(['node_id', 'gravatar_id', '_links', 'etag', 'avatar_url']);
/** Clés se terminant par _url supprimées, sauf celles-ci qui servent à l'utilisateur. */
const DEFAULT_KEEP_KEYS = new Set(['html_url', 'web_url', 'permalink_url', 'browser_url']);
/** Champs qui portent du CONTENU à lire (fichier, diff, sortie) : protégés de la réduction stricte. */
const DEFAULT_CONTENT_KEYS = new Set([
  'content',
  'text',
  'body',
  'code',
  'diff',
  'patch',
  'source',
  'stdout',
  'stderr',
  'output',
  'log',
  'logs',
]);

/**
 * Étapes de réduction appliquées l'une après l'autre quand un JSON dépasse son budget :
 * moins d'éléments par liste, textes plus courts. On s'arrête à la première qui rentre.
 */
const SHRINK_STEPS: ReadonlyArray<{ items: number; str: number }> = [
  { items: 10, str: 400 },
  { items: 6, str: 200 },
  { items: 4, str: 120 },
  { items: 3, str: 80 },
];

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

export interface ResultFilterOptions {
  maxChars: number;
  /** Budget de l'enveloppe d'un résultat JSON ; à défaut, maxChars. */
  jsonMaxChars?: number;
  maxArrayItems: number;
  maxString: number;
  /** Champs de contenu protégés de la réduction stricte. */
  contentKeys?: Set<string>;
  /** Taille maximale d'un champ de contenu protégé ; à défaut, maxString. */
  contentMax?: number;
  dropKeys: Set<string>;
  keepKeys: Set<string>;
}

export function isResultFilterEnabled(): boolean {
  return process.env.MCP_RESULT_FILTER?.toLowerCase() !== 'false';
}

export function getResultFilterOptions(): ResultFilterOptions {
  const maxChars = readInt('MCP_RESULT_MAX_CHARS', DEFAULT_MAX_CHARS);
  const maxString = readInt('MCP_RESULT_MAX_STRING', DEFAULT_MAX_STRING);
  return {
    maxChars,
    jsonMaxChars: readInt('MCP_RESULT_JSON_MAX_CHARS', maxChars),
    maxArrayItems: readInt('MCP_RESULT_MAX_ARRAY_ITEMS', DEFAULT_MAX_ARRAY_ITEMS),
    maxString,
    contentKeys: new Set([...DEFAULT_CONTENT_KEYS, ...readList('MCP_RESULT_CONTENT_KEYS')]),
    contentMax: readInt('MCP_RESULT_CONTENT_MAX_CHARS', maxString),
    dropKeys: new Set([...DEFAULT_DROP_KEYS, ...readList('MCP_RESULT_DROP_KEYS')]),
    keepKeys: new Set([...DEFAULT_KEEP_KEYS, ...readList('MCP_RESULT_KEEP_KEYS')]),
  };
}

function shouldDropKey(key: string, options: ResultFilterOptions): boolean {
  if (options.keepKeys.has(key)) {
    return false;
  }
  return options.dropKeys.has(key) || key.endsWith('_url');
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0)
  );
}

function truncateString(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}… [${value.length - max} caractères omis]`;
}

function pruneValue(value: unknown, options: ResultFilterOptions, depth: number): unknown {
  if (typeof value === 'string') {
    return truncateString(value, options.maxString);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[…profondeur maximale atteinte]';
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, options.maxArrayItems)
      .map((item) => pruneValue(item, options, depth + 1))
      .filter((item) => !isEmpty(item));
    if (value.length > options.maxArrayItems) {
      kept.push(
        `[${value.length - options.maxArrayItems} autres éléments omis sur ${value.length} au total]`,
      );
    }
    return kept;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (shouldDropKey(key, options)) {
      continue;
    }
    // Contenu à lire (fichier, diff, sortie) : gardé jusqu'à contentMax, pas réduit comme l'enveloppe.
    const pruned =
      typeof child === 'string' && options.contentKeys?.has(key)
        ? truncateString(child, options.contentMax ?? options.maxString)
        : pruneValue(child, options, depth + 1);
    if (!isEmpty(pruned)) {
      output[key] = pruned;
    }
  }
  return output;
}

function capLength(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return (
    `${text.slice(0, maxChars)}\n\n[Résultat tronqué : ${omitted} caractères omis sur ${text.length}. ` +
    `Refaire la demande avec des critères plus précis ou une pagination pour obtenir la suite.]`
  );
}

/** Total des caractères des champs de contenu protégés dans un JSON déjà nettoyé. */
function countContentChars(value: unknown, options: ResultFilterOptions): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countContentChars(item, options), 0);
  }
  let total = 0;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string' && options.contentKeys?.has(key)) {
      total += child.length;
    } else {
      total += countContentChars(child, options);
    }
  }
  return total;
}

/**
 * Nettoie un JSON puis, si son enveloppe dépasse le budget, la réduit étape par étape
 * (SHRINK_STEPS) pour garder l'essentiel et rester du JSON valide. Le contenu protégé
 * (fichier, diff, sortie) a sa propre allocation et n'est pas réduit par ces étapes.
 * Les marqueurs « autres éléments omis » et « caractères omis » signalent à l'IA ce qui
 * a été retiré. En dernier recours seulement, le texte est coupé.
 */
function fitJson(parsed: unknown, options: ResultFilterOptions): string {
  const first = pruneValue(parsed, options, 0) ?? null;
  const budget = (options.jsonMaxChars ?? options.maxChars) + countContentChars(first, options);
  let text = JSON.stringify(first);
  if (text.length <= budget) {
    return text;
  }
  for (const step of SHRINK_STEPS) {
    const smaller: ResultFilterOptions = {
      ...options,
      maxArrayItems: Math.min(options.maxArrayItems, step.items),
      maxString: Math.min(options.maxString, step.str),
    };
    text = JSON.stringify(pruneValue(parsed, smaller, 0) ?? null);
    if (text.length <= budget) {
      return text;
    }
  }
  return capLength(text, budget);
}

/**
 * Nettoie le texte d'un résultat d'outil MCP. Ne lève jamais d'erreur : en cas
 * de problème, le texte d'origine est renvoyé tel quel.
 */
export function compactToolText(text: string, options?: ResultFilterOptions): string {
  try {
    if (!isResultFilterEnabled() || typeof text !== 'string' || text.length === 0) {
      return text;
    }
    const opts = options ?? getResultFilterOptions();
    const trimmed = text.trim();

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        // JSON compact (sans indentation) : moins de tokens
        return fitJson(parsed, opts);
      } catch {
        /* Pas du JSON valide : traité comme du texte brut ci-dessous */
      }
    }

    return capLength(text, opts.maxChars);
  } catch {
    return text;
  }
}
