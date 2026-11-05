// Choix de l'hébergeur OpenRouter pour le modèle de travail (le moins cher qui reste rapide).
// Ajoute au build, dans src/server.js, le réglage `provider.order` de OpenRouter :
//   LLM_PROVIDER_ORDER = 'Relace'  (défaut ; liste séparée par des virgules, ex. 'Relace,Wafer')
//   LLM_PROVIDER_ORDER = ''        (vide : OpenRouter choisit lui-même, comme avant)
// Si Relace est en panne, OpenRouter bascule sur un autre hébergeur (allow_fallbacks).
// Jamais bloquant : si une ancre est introuvable, le patch est ignoré avec un avertissement.
import fs from "node:fs";

const file = "src/server.js";

try {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes("LLM_PROVIDER_ORDER")) {
    console.log("patch-provider : déjà appliqué");
  } else {
    const cfgAnchor = 'llmReasoning: e.LLM_REASONING_EFFORT || "",';
    const bodyAnchor = '...(C.llmBase.includes("openrouter.ai") ? { usage: { include: true } } : {}),';
    if (!src.includes(cfgAnchor) || !src.includes(bodyAnchor)) {
      console.warn("patch-provider : ancre introuvable, patch ignoré");
    } else {
      src = src.replace(
        cfgAnchor,
        () =>
          'llmProvider: e.LLM_PROVIDER_ORDER === undefined ? "Relace" : e.LLM_PROVIDER_ORDER,\n  ' +
          cfgAnchor
      );
      src = src.replace(
        bodyAnchor,
        () =>
          bodyAnchor +
          '\n        ...(C.llmBase.includes("openrouter.ai") && C.llmProvider ? { provider: { order: C.llmProvider.split(",").map((s) => s.trim()).filter(Boolean), allow_fallbacks: true } } : {}),'
      );
      fs.writeFileSync(file, src);
      console.log("patch-provider : appliqué");
    }
  }
} catch (err) {
  console.warn("patch-provider : ignoré (" + (err && err.message) + ")");
}
