/**
 * Filtre générique appliqué à TOUS les résultats d'outils MCP (serveurs officiels
 * et personnalisés), avant qu'ils n'arrivent à l'IA. Objectif : réduire les tokens
 * sans perdre l'information utile.
 *
 * Réglages (variables d'environnement, toutes optionnelles) :
 * - MCP_RESULT_FILTER=false          désactive complètement le filtre
 * - MCP_RESULT_MAX_CHARS=12000       taille maximale d'un résultat texte
 * - MCP_RESULT_MAX_ARRAY_ITEMS=25    nombre maximal d'éléments gardés par liste
 * - MCP_RESULT_MAX_STRING=2000       taille maximale d'une chaîne dans un JSON
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
  maxArrayItems: number;
  maxString: number;
  dropKeys: Set<string>;
  keepKeys: Set<string>;
}

export function isResultFilterEnabled(): boolean {
  return process.env.MCP_RESULT_FILTER?.toLowerCase() !== 'false';
}

export function getResultFilterOptions(): ResultFilterOptions {
  return {
    maxChars: readInt('MCP_RESULT_MAX_CHARS', DEFAULT_MAX_CHARS),
    maxArrayItems: readInt('MCP_RESULT_MAX_ARRAY_ITEMS', DEFAULT_MAX_ARRAY_ITEMS),
    maxString: readInt('MCP_RESULT_MAX_STRING', DEFAULT_MAX_STRING),
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
    const pruned = pruneValue(child, options, depth + 1);
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
        const pruned = pruneValue(parsed, opts, 0);
        // JSON compact (sans indentation) : moins de tokens
        return capLength(JSON.stringify(pruned ?? null), opts.maxChars);
      } catch {
        /* Pas du JSON valide : traité comme du texte brut ci-dessous */
      }
    }

    return capLength(text, opts.maxChars);
  } catch {
    return text;
  }
}
