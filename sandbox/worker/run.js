import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { filterOutput } from "./output-filter.js";

// Exécuteur PASSIF : ce conteneur n'a ni IA, ni clé LLM. L'IA du chat envoie des commandes
// (outil execute_command) via l'orchestrateur ; ce programme les lance une par une et renvoie la sortie.
// Annulation : dès que l'orchestrateur signale l'arrêt (clic sur Stop dans le chat), tout le groupe
// de processus de la commande reçoit SIGTERM, puis SIGKILL 2 s plus tard.
// Économie de tokens : la sortie passe par output-filter.js (bruit retiré, fiche courte en cas d'échec,
// code affiché jamais réduit). Le journal complet de chaque commande reste dans /tmp/out-<id>.log.
const { JOB_TOKEN, ORCHESTRATOR_URL, MAX_RUNTIME_SEC = "3600" } = process.env;
const ROOT = process.env.WORK_ROOT || "/work";
const HEAD = 2500;
const TAIL = 9500;
const LOG_MAX = 5_000_000; // plafond du journal complet par commande (octets)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts = {}, timeoutMs = 30000) {
  const r = await fetch(ORCHESTRATOR_URL + p, {
    ...opts,
    headers: { Authorization: `Bearer ${JOB_TOKEN}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

// Garde le début et la fin de la sortie (l'erreur est presque toujours à la fin).
function collector(headMax = HEAD, tailMax = TAIL) {
  let head = "";
  let tail = "";
  let total = 0;
  return {
    push(chunk) {
      const s = chunk.toString("utf8");
      total += s.length;
      if (head.length < headMax) {
        const room = headMax - head.length;
        head += s.slice(0, room);
        tail += s.slice(room);
      } else {
        tail += s;
      }
      if (tail.length > tailMax * 2) tail = tail.slice(-tailMax);
    },
    text() {
      const t = tail.length > tailMax ? tail.slice(-tailMax) : tail;
      const cut = total - head.length - t.length;
      return cut > 0 ? `${head}\n...[${cut} caractères omis]...\n${t}` : head + t;
    },
  };
}

const scrub = (text, env) => {
  let t = String(text);
  for (const v of Object.values(env)) if (typeof v === "string" && v.length >= 8) t = t.split(v).join("***");
  return t;
};

function execCommand(c, env) {
  return new Promise((resolve) => {
    const col = collector(); // sortie brute telle qu'avant (secours si le filtre échoue)
    const full = collector(100000, 300000); // matière du filtre : début et fin, bien plus large
    let cwd = ROOT;
    if (c.cwd) {
      cwd = path.resolve(ROOT, c.cwd);
      if (cwd !== ROOT && !cwd.startsWith(ROOT + path.sep)) {
        return resolve({ code: 2, out: "cwd hors de /work", timedOut: false, signal: null });
      }
      if (!fs.existsSync(cwd)) return resolve({ code: 2, out: `dossier introuvable : ${c.cwd}`, timedOut: false, signal: null });
    }
    // Journal complet : l'IA le relit avec tail, grep ou cat si la fiche ne suffit pas.
    const logPath = `/tmp/out-${String(c.id).replace(/[^\w-]/g, "")}.log`;
    let log = null;
    try {
      log = fs.createWriteStream(logPath, { flags: "w", mode: 0o600 });
      log.on("error", () => {});
    } catch {
      log = null;
    }
    let logged = 0;
    const feed = (d) => {
      col.push(d);
      full.push(d);
      if (log && logged < LOG_MAX) {
        logged += d.length;
        log.write(d);
      }
    };
    const child = spawn("bash", ["-lc", c.command], {
      cwd,
      detached: true, // nouveau groupe de processus : on peut tuer toute l'arborescence d'un coup
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: "/home/worker",
        CI: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "AI Bot",
        GIT_AUTHOR_EMAIL: "ai-bot@users.noreply.github.com",
        GIT_COMMITTER_NAME: "AI Bot",
        GIT_COMMITTER_EMAIL: "ai-bot@users.noreply.github.com",
        ...env,
      },
    });
    let timedOut = false;
    let cancelled = false;
    let finished = false;
    let killTimer = null;
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {}
    };
    const stop = () => {
      if (finished || killTimer) return;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Number(c.timeout) * 1000);

    const done = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {}
      try {
        if (log) log.end();
      } catch {}
      let out;
      try {
        out = filterOutput({
          command: c.command,
          code,
          signal,
          timedOut,
          timeoutSec: Number(c.timeout),
          raw: full.text(),
          logPath,
        }).text;
      } catch (err) {
        console.error("filtre de sortie :", err.message);
        out = col.text();
      }
      resolve({ code, signal: signal || null, timedOut, cancelled, out: scrub(out, env) });
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => {
      feed(Buffer.from(`erreur de lancement : ${err.message}`));
      done(127, null);
    });
    // 'exit' + courte marge pour vider les tuyaux (un processus d'arrière-plan peut garder 'close' ouvert).
    child.on("exit", (code, signal) => setTimeout(() => done(code, signal), 400));
    child.on("close", (code, signal) => done(code, signal));

    // Surveillance de l'annulation : requête longue ; l'orchestrateur répond tout de suite au clic sur Stop.
    (async () => {
      while (!finished) {
        try {
          const r = await api(`/internal/watch/${c.id}`, {}, 35000);
          if (r.cancel && !finished) {
            cancelled = true;
            stop();
            return;
          }
          if (r.done) return;
        } catch {
          await sleep(500);
        }
      }
    })();
  });
}

setTimeout(() => process.exit(1), Number(MAX_RUNTIME_SEC) * 1000);

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  let fails = 0;
  for (;;) {
    let r;
    try {
      r = await api("/internal/next", {}, 35000);
      fails = 0;
    } catch (err) {
      fails += 1;
      if (fails > 20) {
        console.error("orchestrateur injoignable, arrêt");
        process.exit(1);
      }
      await sleep(1000);
      continue;
    }
    if (r.stop) process.exit(0);
    if (!r.cmd) continue;
    const res = await execCommand(r.cmd, r.env || {});
    for (let i = 0; i < 3; i++) {
      try {
        await api(`/internal/cmd/${r.cmd.id}`, { method: "POST", body: JSON.stringify(res) });
        break;
      } catch {
        await sleep(500);
      }
    }
  }
}

main();
