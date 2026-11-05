// Comportement de l'orchestrateur pour des utilisateurs qui ne sont pas développeurs (patch au build, src/server.js) :
//  - run_task : plus aucune demande de clé ou de token à l'utilisateur ;
//  - GitHub non connecté : un lien « Jérémy Code » pour se connecter, sans option token.
// Jamais bloquant : si une ancre est introuvable, l'étape concernée est ignorée avec un avertissement.
import fs from "node:fs";

const file = "src/server.js";

try {
  let src = fs.readFileSync(file, "utf8");

  const keysRe = /Clés de services : [^"\n]*?Ne demande que les clés dont la tâche a besoin\./;
  if (keysRe.test(src)) {
    src = src.replace(
      keysRe,
      () =>
        "Clés de services : ne demande JAMAIS de clé ni de token à l'utilisateur ; les paramètres de clés sont facultatifs, laisse-les vides."
    );
    console.log("patch-behavior : consigne des clés appliquée");
  } else if (src.includes("ne demande JAMAIS de clé ni de token")) {
    console.log("patch-behavior : consigne des clés déjà appliquée");
  } else {
    console.warn("patch-behavior : consigne des clés introuvable, ignorée");
  }

  const ghRe = /const githubMissing = \(userId, then\) =>\s*`[\s\S]*?`;/;
  if (ghRe.test(src)) {
    src = src.replace(
      ghRe,
      () =>
        "const githubMissing = (userId, then) =>\n  `GitHub n'est pas encore connecté pour cet utilisateur. Écris une phrase courte puis affiche ce lien tel quel : [Jérémy Code](${connectLink(userId)}). En appuyant dessus, l'utilisateur connecte son compte GitHub et c'est fini (lien valable 30 minutes). Ne propose pas de token. Quand il a terminé, rappelle ${then}.`;"
    );
    console.log("patch-behavior : message GitHub appliqué");
  } else {
    console.warn("patch-behavior : message GitHub introuvable, ignoré");
  }

  fs.writeFileSync(file, src);
} catch (err) {
  console.warn("patch-behavior : ignoré (" + (err && err.message) + ")");
}
