/**
 * Outils MCP allégés : descriptions raccourcies avant l'envoi au modèle (route /ai-proxy).
 * Les serveurs comme Supabase, Render ou Cloudflare envoient des descriptions très longues pour chaque outil et
 * chaque paramètre ; elles sont renvoyées au modèle à CHAQUE appel et comptent dans le quota de tokens.
 * Ici : description d'outil limitée à 200 caractères, description de paramètre à 60 (120 pour le schéma
 * racine), exemples retirés. Les noms, types, valeurs possibles (enum) et champs obligatoires ne changent pas.
 * Le terminal (noms contenant « _mcp_sandbox ») n'est JAMAIS modifié : ses descriptions sont réglées à la main.
 * Google Drive (« _mcp_google-drive ») n'est pas modifié non plus : la description de create_file précise que le
 * contenu doit être encodé en base64, et celle de search_files explique la syntaxe de recherche.
 * Jamais bloquant : si l'ancre est introuvable, le fichier reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'patch-slim-tools.js';
const anchor = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';

const block = String.raw`    // Outils allégés (patch-slim-tools.js) : descriptions raccourcies pour les serveurs MCP autres que le terminal et Google Drive.
    try {
      if (Array.isArray(body.tools) && body.tools.length > 0) {
        const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
        const slim = (node, depth) => {
          if (Array.isArray(node)) return node.map((x) => slim(x, depth + 1));
          if (!node || typeof node !== "object") return node;
          const out = {};
          for (const [k, v] of Object.entries(node)) {
            if (k === "description" && typeof v === "string") out[k] = cut(v, depth === 0 ? 120 : 60);
            else if (k === "examples" || k === "example" || k === "$comment") continue;
            else out[k] = slim(v, depth + 1);
          }
          return out;
        };
        body.tools = body.tools.map((t) => {
          const fn = t && t.function;
          if (!fn || typeof fn.name !== "string" || fn.name.includes("_mcp_sandbox") || fn.name.includes("_mcp_google-drive")) return t;
          return { ...t, function: { ...fn, description: cut(fn.description, 200), parameters: slim(fn.parameters, 0) } };
        });
      }
    } catch (e) {
      /* jamais bloquant */
    }
`;

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-slim-tools : aiModels.js illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-slim-tools : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-slim-tools : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => anchor + block));
console.log('patch-slim-tools : appliqué');
