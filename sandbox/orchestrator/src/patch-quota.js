// Patch de build : quota de tokens par jour et par utilisateur (3 000 000 par défaut, variable TOKENS_PER_USER_DAY).
// Depuis le moteur unique (l'IA du chat pilote le terminal), plus aucune IA ne tourne dans le conteneur : les tokens
// sont comptés par LibreChat (route /ai-proxy) puis envoyés ici (POST /usage). L'orchestrateur les range par
// utilisateur et par jour (table usage), répond au solde (GET /quota, outil my_quota) et refuse les commandes du
// terminal quand le quota est épuisé.
// Économie de tokens : chaque résultat de commande est relu par l'IA du chat à toutes les étapes suivantes.
//  - les sorties courtes (jusqu'à 6 000 caractères) sont renvoyées entières, sans codes de couleur, sans barres de
//    progression ni lignes répétées (ainsi cat d'un fichier reste lisible en entier) ;
//  - les sorties longues sont résumées SANS IA et sans coût : début, lignes d'erreur, fin, et le nombre de lignes omises.
// Idempotent. Si une ancre est introuvable, le build échoue volontairement (l'ancienne version reste en ligne).
import fs from "node:fs";

const file = "src/server.js";
let src = fs.readFileSync(file, "utf8");

if (src.includes("quotaInfo")) {
  console.log("patch-quota : déjà appliqué");
  process.exit(0);
}

const OK_LINE = 'const ok = (t) => ({ content: [{ type: "text", text: t }] });\n';

const COMPACT = String.raw`// Résumé des sorties de commandes, sans IA et sans coût : retire les codes de couleur, les barres de progression
// et les lignes répétées. Jusqu'à 6000 caractères, la sortie est renvoyée entière ; au-delà, on garde le début,
// les lignes d'erreur et la fin, avec le nombre de lignes omises.
const compact = (text) => {
  const clean = String(text)
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
  const lines = [];
  let last = "";
  let repeat = 0;
  const flush = () => {
    if (repeat > 0) lines.push("(ligne répétée " + repeat + " fois)");
    repeat = 0;
  };
  for (const raw of clean.split("\n")) {
    const l = raw.replace(/\s+$/, "");
    if (!l.trim()) continue;
    if (/^[\s\[\(#=>.\-|\\\/]{5,}\]?\s*\d*%?\s*$/.test(l) || /\d+%\s*[|\[#=]/.test(l)) continue;
    if (l === last) {
      repeat += 1;
      continue;
    }
    flush();
    lines.push(l);
    last = l;
  }
  flush();
  const full = lines.join("\n");
  if (full.length <= 6000) return full;
  const bad = /error|erreur|ERR!|failed|fatal|exception|traceback|cannot|not found|denied|ENOENT|EACCES|warn/i;
  const head = lines.slice(0, 8);
  const tail = lines.slice(-20);
  const middle = lines.slice(8, -20);
  const important = middle.filter((l) => bad.test(l)).slice(0, 12);
  const omitted = middle.length - important.length;
  const out =
    head.join("\n") +
    "\n...[" + omitted + " lignes omises : utilise grep, head ou tail pour en voir plus]...\n" +
    (important.length ? important.join("\n") + "\n...\n" : "") +
    tail.join("\n");
  return out.length > 4500 ? out.slice(0, 1500) + "\n...[tronqué]...\n" + out.slice(-3000) : out;
};
`;

const edits = [
  [
    "role de l'utilisateur",
    "  req.userId = user;\n",
    "  req.userId = user;\n  req.userRole = String(req.headers['x-user-role'] || '').toUpperCase();\n",
  ],
  [
    "signature buildServer",
    "function buildServer(userId, ghHeader, svcHeaders, reqSignal) {",
    "function buildServer(userId, ghHeader, svcHeaders, reqSignal, userRole) {",
  ],
  [
    "appel buildServer",
    'buildServer(req.userId, String(req.headers["x-github-token"] || ""), svcFrom(req.headers), ctl.signal);',
    'buildServer(req.userId, String(req.headers["x-github-token"] || ""), svcFrom(req.headers), ctl.signal, req.userRole);',
  ],
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
  ["résumé des sorties", OK_LINE, COMPACT + "\n" + OK_LINE],
  [
    "sortie résumée",
    'const out = clip(scrubWith(sx.secrets, r.out || "")).trim();',
    'const out = clip(compact(scrubWith(sx.secrets, r.out || ""))).trim();',
  ],
  [
    "refus du terminal",
    "      const command = String(args.command || \"\").trim();\n",
    "      if (userRole !== \"ADMIN\" && quotaInfo(userId).remaining <= 0) {\n" +
      "        return ko(\"Le quota de tokens du jour de cet utilisateur est épuisé. Il se renouvelle demain. Dis-le en une phrase et arrête-toi : ne lance plus de commande.\");\n" +
      "      }\n" +
      "      const command = String(args.command || \"\").trim();\n",
  ],
  [
    "my_quota",
    "        sessions_restantes: Math.max(C.sessionsPerDay - u.jobs, 0),\n",
    "        sessions_restantes: Math.max(C.sessionsPerDay - u.jobs, 0),\n" +
      "        tokens_restants: userRole === \"ADMIN\" ? C.tokensPerDay : quotaInfo(userId).remaining,\n" +
      "        admin: userRole === \"ADMIN\",\n" +
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
    "limite de sortie",
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
