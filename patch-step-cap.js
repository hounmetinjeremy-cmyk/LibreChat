/**
 * Plafond d'appels d'outils par message utilisateur (route interne /ai-proxy, api/server/routes/aiModels.js).
 * Pourquoi : à chaque appel d'outil, tout l'historique est renvoyé au modèle. Une tâche qui boucle (même commande
 * relancée, outil qui échoue) peut ainsi consommer des dizaines de millions de tokens avant de s'arrêter ; la limite
 * de récursion de LibreChat (endpoints.agents) n'a pas arrêté une boucle de plus de 300 étapes.
 * Ici : on compte les résultats d'outils reçus depuis le dernier message de l'utilisateur. Au-delà de MAX_TOOL_STEPS
 * (60 par défaut, variable d'environnement Fly), la requête est refusée avec un message clair. L'utilisateur écrit
 * « continue » pour repartir : un nouveau message remet le compteur à zéro. MAX_TOOL_STEPS=0 supprime le plafond.
 * Le compte ADMIN n'est PAS limité par défaut (MAX_TOOL_STEPS_ADMIN=0) : il ne doit jamais être arrêté en plein travail.
 * Pour lui donner quand même un plafond (garde-fou contre une boucle), définir MAX_TOOL_STEPS_ADMIN (ex. 300).
 * Le refus part en erreur 429 : LibreChat l'affiche comme « The provider declined this request for exceeding a rate or
 * spending limit », sans notre texte.
 * Jamais bloquant : si l'ancre est introuvable, le fichier reste tel quel (avertissement). Idempotent.
 */
const fs = require('fs');

const file = 'api/server/routes/aiModels.js';
const marker = 'patch-step-cap.js';
const anchor = '    body.messages = await convertMessages(body.messages, resolveVision(cfg));\n';

const block = String.raw`    // Plafond d'appels d'outils par message (patch-step-cap.js).
    try {
      const capMsgs = Array.isArray(body.messages) ? body.messages : [];
      let capSteps = 0;
      for (let i = capMsgs.length - 1; i >= 0; i--) {
        const m = capMsgs[i];
        if (m && m.role === "user") break;
        if (m && m.role === "tool") capSteps++;
      }
      const capAdmin = String((req.headers && req.headers["x-user-role"]) || "").toUpperCase() === "ADMIN";
      const capMax = Math.floor(Number(capAdmin ? (process.env.MAX_TOOL_STEPS_ADMIN ?? "0") : (process.env.MAX_TOOL_STEPS ?? "60")));
      if (capMax > 0 && capSteps >= capMax) {
        const capText = "Trop d'étapes pour ce seul message (" + capSteps + " appels d'outils) : je m'arrête pour ne pas gaspiller de tokens. Écris « continue » pour que je poursuive.";
        return res.status(429).json(typeof err === "function" ? err(capText) : { error: { message: capText } });
      }
    } catch (e) {
      /* jamais bloquant */
    }
`;

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-step-cap : aiModels.js illisible, ignoré');
  process.exit(0);
}

if (src.includes(marker)) {
  console.log('patch-step-cap : déjà appliqué');
  process.exit(0);
}

const count = src.split(anchor).length - 1;
if (count !== 1) {
  console.warn(`patch-step-cap : ancre trouvée ${count} fois (attendu : 1), ignoré`);
  process.exit(0);
}

fs.writeFileSync(file, src.replace(anchor, () => anchor + block));
console.log('patch-step-cap : appliqué');
