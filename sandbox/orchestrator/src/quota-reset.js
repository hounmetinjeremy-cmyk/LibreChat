// Remise à zéro des compteurs du jour, déclenchée par un déploiement : lancé avant le serveur (voir Dockerfile).
// Si la variable QUOTA_RESET_ID (fly.toml) a changé depuis la dernière fois, les compteurs d'aujourd'hui
// (tâches et tokens, tous utilisateurs) sont effacés. Même valeur = rien ne se passe. Pour une nouvelle remise
// à zéro : changer la valeur de QUOTA_RESET_ID puis redéployer.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const id = process.env.QUOTA_RESET_ID;
if (id) {
  try {
    const dbPath = process.env.DB_PATH || "/data/orch.db";
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS usage (user_id TEXT NOT NULL, day TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, jobs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))");
    db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
    const cur = db.prepare("SELECT v FROM meta WHERE k='quota_reset'").get();
    if (!cur || cur.v !== id) {
      const day = new Date().toISOString().slice(0, 10);
      const r = db.prepare("DELETE FROM usage WHERE day=?").run(day);
      db.prepare("INSERT INTO meta (k,v) VALUES ('quota_reset',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(id);
      console.log(`quota-reset : compteurs du ${day} remis à zéro (${r.changes} lignes), id ${id}`);
    } else {
      console.log(`quota-reset : id ${id} déjà appliqué`);
    }
    db.close();
  } catch (err) {
    console.error("quota-reset : échec ignoré :", err.message);
  }
}
