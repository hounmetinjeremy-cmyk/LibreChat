// Cloudflare côté orchestrateur (patch au build, src/server.js) :
//  - run_task : si l'utilisateur a relié Cloudflare dans LibreChat, ses identifiants sont ajoutés au conteneur
//    (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) et l'agent reçoit la consigne de déploiement wrangler pages ;
//  - outil link_pages : lie un dépôt GitHub à Cloudflare Pages (republication à chaque push).
// Jamais bloquant : si une ancre est introuvable, le patch est ignoré avec un avertissement.
import fs from "node:fs";

const file = "src/server.js";
const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");

try {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes("cloudflareEnv")) {
    console.log("patch-cloudflare : déjà appliqué");
  } else {
    const fnAnchor = "async function pickGithub(userId, chatToken, headerToken) {";
    const svcAnchor = "const svc = { ...svcHeaders, ...svcFromParams(args) };";
    const credsAnchor = "instructions, svc, exp:";
    const okAnchor = "return ok(`Tâche ${r.id} lancée.";
    const toolRe = /\n  s\.tool\(\n    "get_job",/;
    const missing = [fnAnchor, svcAnchor, credsAnchor, okAnchor].filter((a) => !src.includes(a));
    if (missing.length || !toolRe.test(src)) {
      console.warn("patch-cloudflare : ancre introuvable, patch ignoré : " + (missing[0] || "get_job").slice(0, 50));
    } else {
      src = src.replace(fnAnchor, () => read("./cf-fn.snippet") + fnAnchor);
      src = src.replace(svcAnchor, () =>
        [
          svcAnchor,
          "const cf = svc.CLOUDFLARE_API_TOKEN ? null : await cloudflareEnv(userId);",
          "      if (cf && cf.env) Object.assign(svc, cf.env);",
          "      const cfInstr = svc.CLOUDFLARE_API_TOKEN ? CF_DEPLOY_NOTE : CF_MISSING_NOTE;",
          '      const cfNote = cf && cf.invalid ? CF_INVALID_NOTE : "";',
        ].join("\n")
      );
      src = src.replace(credsAnchor, () => "instructions: instructions + cfInstr, svc, exp:");
      src = src.replace(okAnchor, () => "return ok(cfNote + `Tâche ${r.id} lancée.");
      src = src.replace(toolRe, (m) => "\n" + read("./cf-tool.snippet") + m.slice(1));
      fs.writeFileSync(file, src);
      console.log("patch-cloudflare : appliqué");
    }
  }
} catch (err) {
  console.warn("patch-cloudflare : ignoré (" + (err && err.message) + ")");
}
