// Nettoyage des résultats : on supprime le bruit (URLs d'API, ids internes, valeurs vides),
// on tronque les listes et les textes, puis on plafonne la taille totale.

const DROP = /^(url|node_id|gravatar_id|_links|etag|user_view_type|site_admin|permissions)$|_url$/i;
const KEEP = new Set(['html_url']);

function decodeBase64Utf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function clean(value, opts) {
  const maxItems = opts.maxItems;
  const maxStr = opts.maxStr;

  const walk = (v, depth) => {
    if (v === null || v === undefined || v === '') return undefined;
    if (typeof v === 'string') {
      return v.length > maxStr ? v.slice(0, maxStr) + `…[+${v.length - maxStr} car.]` : v;
    }
    if (Array.isArray(v)) {
      const items = v
        .slice(0, maxItems)
        .map((x) => walk(x, depth + 1))
        .filter((x) => x !== undefined);
      if (v.length > maxItems) items.push(`…+${v.length - maxItems} autres`);
      return items.length ? items : undefined;
    }
    if (typeof v === 'object') {
      if (depth > 6) return undefined;
      // Fichier GitHub en base64 : on décode pour que l'agent lise du texte.
      if (v.encoding === 'base64' && typeof v.content === 'string') {
        try {
          v = { ...v, content: decodeBase64Utf8(v.content), encoding: undefined };
        } catch {
          /* on garde tel quel */
        }
      }
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (DROP.test(k) && !KEEP.has(k)) continue;
        const c = walk(x, depth + 1);
        if (c !== undefined) out[k] = c;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return v; // nombres, booléens (false et 0 sont conservés)
  };

  return walk(value, 0);
}

// Transforme un résultat d'outil MCP en un court texte pour l'agent.
export function formatResult(result, opts) {
  if (!result) return '(résultat vide)';
  const blocks = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      let t = b.text || '';
      try {
        const cleaned = clean(JSON.parse(t), opts);
        t = cleaned === undefined ? '(vide)' : JSON.stringify(cleaned);
      } catch {
        /* texte brut */
      }
      parts.push(t);
    } else if (b.type === 'image') {
      parts.push('[image omise]');
    } else {
      parts.push(`[${b.type} omis]`);
    }
  }
  let text = parts.join('\n') || '(résultat vide)';
  if (text.length > opts.maxChars) {
    const extra = text.length - opts.maxChars;
    text = text.slice(0, opts.maxChars) + `\n…[tronqué : ${extra} caractères de plus, affine ta demande]`;
  }
  return result.isError ? `ERREUR : ${text}` : text;
}
