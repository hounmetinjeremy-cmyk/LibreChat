// Patch de build : quota de tokens par jour et par utilisateur (3 000 000 par défaut, variable TOKENS_PER_USER_DAY).
// Depuis le moteur unique (l'IA du chat pilote le terminal), plus aucune IA ne tourne dans le conteneur : les tokens
// sont comptés par LibreChat (route /ai-proxy) puis envoyés ici (POST /usage). L'orchestrateur les range par
// utilisateur et par jour (table usage), répond au solde (GET /quota, outil my_quota) et refuse les commandes du
// terminal quand le quota est épuisé.
// Économie de tokens : la sortie d'une commande est limitée à 6 000 caractères (environ 1 500 tokens) au lieu de
// 12 000, car chaque résultat est ensuite relu par l'IA du chat à chaque étape suivante.
// Idempotent. Si une ancre est introuvable, le build échoue volontairement (l'ancienne version reste en ligne).
import fs from "node:fs";

const file = "src/server.js";
let src = fs.readFileSync(file, "utf8");

if (src.includes("quotaInfo")) {
  console.log("patch-quota : déjà appliqué");
  process.exit(0);
}

const edits = [
  [
    "configuration",
    "  cmdDefaultSec: 120,\n",
    "  cmdDefaultSec: 120,\n  tokensPerDay: Number(e.TOKENS_PER_USER_DAY || 3000000), // quota de tokens du chat par utilisateur et par jour\n",
  ],
  [
    "aides",
    "const ACTIVE = \"('queued','running')\";\n",
    "const ACTIVE = \"('queued','running')\";\n" +
      "\n" +
      "// Tokens du jour par utilisateur (comptés par LibreChat, envoyés par POST /usage).\n" +
      "const dayTokens = (userId) => db.prepare(\"SELECT tokens FROM usage WHERE user_id=? AND day=?\").get(userId, today())?.tokens || 0;\n" +
      "const addTokens = (userId, n) =>\n" +
      "  db.prepare(\"INSERT INTO usage (user_id,day,tokens) VALUES (?,?,?) ON CONFLICT(user_id,day) DO UPDATE SET tokens=tokens+?\").run(userId, today(), n, n);\n" +
      "const quotaInfo = (userId) => {\n" +
      "  const used = dayTokens(userId);\n" +
      "  return { used, limit: C.tokensPerDay, remaining: Math.max(C.tokensPerDay - used, 0) };\n" +
      "};\n",
  ],
  [
    "refus du terminal",
    "      const command = String(args.command || \"\").trim();\n",
    "      if (quotaInfo(userId).remaining <= 0) {\n" +
      "        return ko(\"Le quota de tokens du jour de cet utilisateur est épuisé. Il se renouvelle demain. Dis-le en une phrase et arrête-toi : ne lance plus de commande.\");\n" +
      "      }\n" +
      "      const command = String(args.command || \"\").trim();\n",
  ],
  [
    "my_quota",
    "        sessions_restantes: Math.max(C.sessionsPerDay - u.jobs, 0),\n",
    "        sessions_restantes: Math.max(C.sessionsPerDay - u.jobs, 0),\n" +
      "        tokens_restants: quotaInfo(userId).remaining,\n" +
      "        tokens_max_jour: C.tokensPerDay,\n" +
      "        tokens_utilises: quotaInfo(userId).used,\n",
  ],
  [
    "routes",
    "// Arrêt explicite (en plus de l'annulation MCP) : tue la commande en cours de cet utilisateur.\n",
    "// Quota de tokens : lu et alimenté par LibreChat (même identité que le serveur MCP).\n" +
      "app.get(\"/quota\", mcpAuth, (req, res) => {\n" +
      "  res.set(\"Cache-Control\", \"no-store\").json(quotaInfo(req.userId));\n" +
      "});\n" +
      "app.post(\"/usage\", mcpAuth, express.json({ limit: \"4kb\" }), (req, res) => {\n" +
      "  const n = Math.floor(Number(req.body && req.body.tokens));\n" +
      "  if (Number.isFinite(n) && n > 0 && n < 5000000) addTokens(req.userId, n);\n" +
      "  res.json(quotaInfo(req.userId));\n" +
      "});\n" +
      "\n" +
      "// Arrêt explicite (en plus de l'annulation MCP) : tue la commande en cours de cet utilisateur.\n",
  ],
  [
    "sortie des commandes",
    "const clip = (t, n = 12000) =>",
    "const clip = (t, n = 6000) =>",
  ],
];

for (const [label, anchor, replacement] of edits) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) {
    console.error(`patch-quota : ancre « ${label} » trouvée ${count} fois dans ${file} (attendu : 1)`);
    process.exit(1);
  }
  src = src.replace(anchor, () => replacement);
}

fs.writeFileSync(file, src);
console.log("patch-quota : appliqué");
