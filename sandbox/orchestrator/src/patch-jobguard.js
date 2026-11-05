// Garde-fou contre les boucles get_job (patch au build, src/server.js) :
//  - un job_id inventé ou introuvable n'est plus une erreur que l'IA rappelle en boucle : l'outil répond
//    « ARRÊT » (réponse normale) et dit de ne plus appeler get_job ;
//  - run_task refusé (quota, serveur occupé...) précise qu'il n'y a pas de job_id.
// Jamais bloquant : si une ancre est introuvable, l'étape concernée est ignorée avec un avertissement.
import fs from "node:fs";

const file = "src/server.js";

// Remplace une ancre qui doit apparaître exactement une fois.
function swap(src, anchor, replacement, label) {
  const parts = src.split(anchor);
  if (parts.length !== 2) {
    console.warn("patch-jobguard : " + label + " introuvable ou ambigu, ignoré");
    return src;
  }
  console.log("patch-jobguard : " + label + " appliqué");
  return parts.join(replacement);
}

const helper = [
  "// Garde-fou : un job_id inventé ou introuvable ne doit pas relancer get_job en boucle.",
  "const BAD_JOB = new Map();",
  "function stopJob(userId) {",
  "  const now = Date.now();",
  "  const arr = (BAD_JOB.get(userId) || []).filter((t) => now - t < 300000);",
  "  arr.push(now);",
  "  BAD_JOB.set(userId, arr);",
  "  return (",
  "    \"ARRÊT : cette tâche n'existe pas. N'invente jamais de job_id : utilise seulement celui que run_task t'a renvoyé. N'appelle plus get_job. Réponds maintenant à l'utilisateur en une ou deux phrases : si run_task a répondu une erreur, explique-la ; sinon dis que la tâche est introuvable et propose de la relancer.\" +",
  "    (arr.length >= 3 ? \" Tu as déjà essayé \" + arr.length + \" fois : écris ta réponse tout de suite, sans aucun appel d'outil.\" : \"\")",
  "  );",
  "}",
  "",
  "",
].join("\n");

try {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes("const BAD_JOB = new Map()")) {
    console.log("patch-jobguard : déjà appliqué");
  } else {
    src = swap(src, "function buildServer(userId, ghHeader, svcHeaders, tier) {", helper + "function buildServer(userId, ghHeader, svcHeaders, tier) {", "fonction de garde");
    src = swap(src, "job_id: z.string().regex(/^[a-f0-9]{12}$/),", "job_id: z.string().max(64),", "format du job_id assoupli");
    src = swap(
      src,
      "const deadline = Date.now() + (wait_seconds || 0) * 1000;",
      "if (!/^[a-f0-9]{12}$/.test(String(job_id))) return ok(stopJob(userId));\n      const deadline = Date.now() + (wait_seconds || 0) * 1000;",
      "contrôle du job_id"
    );
    src = swap(src, 'if (!j) return ko("Tâche introuvable.");', "if (!j) return ok(stopJob(userId));", "tâche introuvable");
    src = swap(
      src,
      "if (r.error) return ko(r.error);",
      "if (r.error) return ko(r.error + \" Aucune tâche n'a été lancée : il n'y a pas de job_id, n'appelle pas get_job. Explique simplement la situation à l'utilisateur.\");",
      "refus de run_task"
    );
    fs.writeFileSync(file, src);
  }
} catch (err) {
  console.warn("patch-jobguard : ignoré (" + (err && err.message) + ")");
}
