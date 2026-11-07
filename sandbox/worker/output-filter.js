// Filtre des sorties du terminal (brique 1 du middleware d'économie de tokens).
//
// Rôle : ce que l'IA lit après une commande ne doit contenir ni barres de progression, ni warnings
// secondaires, ni logs répétés. En cas d'échec, l'IA reçoit UNE ligne : fichier:ligne — erreur exacte.
// Le journal complet reste sur le disque du conteneur (/tmp/last.log) : l'IA le relit avec tail, grep ou cat
// seulement si cette ligne ne suffit pas.
//
// Règle absolue : une commande qui AFFICHE du contenu (cat, sed, head, git diff, grep...) n'est jamais
// résumée ni dédoublonnée. Seuls les codes de couleur et les barres de progression sont retirés.

const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

const READERS = /^(cat|head|tail|sed|nl|bat|less|more|awk|diff|grep|egrep|rg|jq|xxd|od|strings|git\s+(diff|show|blame|log\s+-p|log\s+--patch))(\s|$)/;

const NOISE = [
  /^\s*npm (warn|notice|WARN)\b/i,
  /^\s*\(?node:\d+\)?\s*(\[?DEP\d+|ExperimentalWarning|Warning)/i,
  /^\s*\(Use `node --trace-(warnings|deprecation)/i,
  /\[[#=>. -]{5,}\]/,
  /^\s*[#=>█▓▒░]{10,}\s*\d*%?\s*$/,
  /^\s*\([#=.\- \u2800-\u28ff]{3,}\)/,
  /^\s*(\S+\s+)?(reify|idealTree|buildIdealTree|reifyNode):/,
  /^\s*\d{1,3}(\.\d+)?%(\s|$)/,
  /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /^\s*(Downloading|Fetching|Resolving|Receiving objects|Resolving deltas|Counting objects|Compressing objects|Writing objects|Unpacking objects|remote: (Counting|Compressing|Enumerating|Total)|Progress:|Get:\d+|Hit:\d+|Ign:\d+|Reading package lists|Building dependency tree|Reading state information|Unpacking|Selecting previously|Preparing to unpack|Setting up|Processing triggers)\b/i,
  /packages? (is|are) looking for funding/i,
  /run `npm fund`/i,
  /^\s*found 0 vulnerabilities/i,
  /^\s*up to date, audited/i,
];

// Lignes qui annoncent une erreur sans la détailler (l'erreur utile est ailleurs).
const WRAPPER = /^\s*(npm (ERR!|error)|error Command failed|error: script ".*" exited|ELIFECYCLE|make(\[\d+\])?: \*\*\*|exit status \d+)/i;
// Faux positifs : « 0 errors », « no errors »...
const WEAK = /\b(0|no|zero|without) errors?\b|error[- ]free|\b0 failed\b|errors?: 0\b/i;
const ERR_LINE =
  /(\b(error|erreur|fatal|failed|failure|exception|panic|cannot|can't|unable to|not found|no such file|permission denied|denied|unexpected|is not defined|is not a function|is not assignable|ENOENT|EACCES|EADDRINUSE|ERR_[A-Z_]+|TS\d{4}|SyntaxError|TypeError|ReferenceError)\b|^\s*(●|FAIL|✗|✖|×)\s)/i;

// Ligne qui commence par un type d'erreur (« Error: ... », « error[E0425]: ... », « FAIL ... ») : meilleur motif.
const TYPED = /^\s*(?:Uncaught\s+)?(?:[A-Za-z]+Error\b|Error\b|Exception\b|fatal:|error(?:\[\w+\])?:|ERROR\b|FATAL\b|panic:|FAIL\b)/;

// Erreurs d'accès GitHub : l'orchestrateur les reconnaît dans la sortie pour proposer la connexion du compte.
const AUTH = /could not read Username|Authentication failed|terminal prompts disabled|Repository not found/i;

const LOC_RE = /((?:[A-Za-z]:)?[\w@~./\\+-]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|php|c|cc|cpp|h|hpp|cs|css|scss|json|ya?ml|sh|toml|html|md))[:(](\d+)(?:[:,](\d+))?\)?/;
const IGNORED_FRAME = /node_modules|node:internal|\(node:|<anonymous>/;

const short = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Retire les codes de couleur, garde la dernière version des lignes réécrites (barres de progression). */
export function plain(raw) {
  let t = String(raw).replace(ANSI_RE, '');
  t = t
    .split('\n')
    .map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l))
    .join('\n');
  // eslint-disable-next-line no-control-regex
  return t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Vrai si la commande affiche du contenu de fichier ou de code : aucune réduction autorisée. */
export function isReader(command) {
  const segments = String(command).split(/&&|\|\||;|\n/);
  for (const seg of segments) {
    let head = seg.split('|')[0].trim();
    head = head.replace(/^(sudo\s+|time\s+|env\s+)/, '').replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    if (READERS.test(head)) return true;
  }
  return false;
}

const isNoise = (l) => NOISE.some((re) => re.test(l));

function groupSimilar(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const key = lines[i].replace(/\d+/g, '#');
    let j = i + 1;
    // Seules les lignes qui contiennent des mots se regroupent : une suite de nombres reste lisible.
    const groupable = (key.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 3;
    while (groupable && j < lines.length && lines[j].replace(/\d+/g, '#') === key) j += 1;
    const n = j - i;
    if (n >= 3) out.push(`${lines[i]} (×${n} lignes similaires)`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out;
}

function clipMiddle(text, head, tail) {
  if (text.length <= head + tail) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n...[${cut} caractères omis]...\n${text.slice(-tail)}`;
}

function frameAfter(lines, i) {
  for (let k = i; k < Math.min(lines.length, i + 8); k++) {
    if (IGNORED_FRAME.test(lines[k])) continue;
    const m = LOC_RE.exec(lines[k]);
    if (m) return `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}`;
  }
  return null;
}

/** Cherche l'erreur essentielle : { file, reason, more } ou null. */
export function extractFailure(lines) {
  // Python : la dernière trace d'appel et son exception.
  let tb = -1;
  lines.forEach((l, i) => {
    if (/^Traceback \(most recent call last\):/.test(l)) tb = i;
  });
  if (tb >= 0) {
    let loc = null;
    for (let i = tb + 1; i < lines.length; i++) {
      const m = /^\s*File "([^"]+)", line (\d+)/.exec(lines[i]);
      if (m) loc = `${m[1]}:${m[2]}`;
      if (/^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(lines[i])) {
        return { file: loc, reason: lines[i], more: 0 };
      }
    }
  }

  const auth = lines.find((l) => AUTH.test(l));
  if (auth) return { file: null, reason: auth, more: 0 };

  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (WRAPPER.test(l) || WEAK.test(l)) continue;
    if (ERR_LINE.test(l)) cands.push(i);
  }
  if (!cands.length) return null;

  const located = cands.map((i) => {
    const l = lines[i];
    let file = null;
    const own = LOC_RE.exec(l);
    if (own && !IGNORED_FRAME.test(l)) file = `${own[1]}:${own[2]}${own[3] ? `:${own[3]}` : ''}`;
    if (!file) {
      // ESLint : « 12:5  error ... » avec le chemin du fichier sur une ligne plus haut.
      const pos = /^\s*(\d+):(\d+)\s+(error|warning)/.exec(l);
      if (pos) {
        for (let k = i - 1; k >= Math.max(0, i - 40); k--) {
          if (/^\/?[\w@~./\\+-]+\.\w+$/.test(lines[k].trim())) {
            file = `${lines[k].trim()}:${pos[1]}:${pos[2]}`;
            break;
          }
        }
      }
    }
    if (!file) file = frameAfter(lines, i + 1);
    const rank = TYPED.test(l) ? 0 : /^\s*\d+:\d+\s+error/.test(l) || own ? 1 : 2;
    return { i, file, rank };
  });

  const best = Math.min(...located.map((c) => c.rank));
  const group = located.filter((c) => c.rank === best);
  const primary = group.find((c) => c.file) || group[0];
  const reasons = new Set(group.map((c) => lines[c.i].replace(/\d+/g, '#').trim()));
  return { file: primary.file, reason: lines[primary.i], more: Math.max(0, reasons.size - 1) };
}

/** Retire du motif le début « fichier:ligne:colonne » ou « fichier(ligne,colonne) » : il est déjà dans la fiche. */
function stripLocation(reason, file) {
  let r = String(reason).trim();
  if (file) {
    const path = file.replace(/:\d+(?::\d+)?$/, '');
    const i = r.indexOf(path);
    if (i >= 0 && i < 12) {
      r = r.slice(i + path.length).replace(/^[:(]\d+(?:[:,]\d+)?\)?\s*[:-]?\s*/, '');
    }
  }
  return r || String(reason).trim();
}

/**
 * Fiche d'échec : UNE ligne « fichier:ligne — erreur exacte » (la commande est connue de l'IA qui l'a lancée).
 * Le détail reste dans le journal complet, que l'IA relit seulement si cette ligne ne suffit pas.
 */
function buildFiche({ failure, timedOut, timeoutSec, signal, lines }) {
  if (timedOut) {
    return `Délai dépassé (${timeoutSec} s), processus tué.`;
  }
  if (failure) {
    const file = failure.file ? failure.file.replace(/:(\d+):\d+$/, ':$1') : null;
    const reason = short(stripLocation(failure.reason, failure.file), 220);
    const more = failure.more > 0 ? ` (+${failure.more} autres erreurs)` : '';
    return file ? `${short(file, 120)} — ${reason}${more}` : `${reason}${more}`;
  }
  const tail = lines.slice(-3).map((l) => short(l, 160));
  if (signal) tail.unshift(`Arrêté par le signal ${signal}.`);
  return tail.join('\n');
}

/**
 * @param {{command:string, code:number|null, signal?:string|null, timedOut?:boolean, timeoutSec?:number,
 *          raw:string, logPath?:string}} o
 * @returns {{text:string, mode:'lecture'|'succes'|'echec'}}
 */
export function filterOutput(o) {
  const cleaned = plain(o.raw || '');

  // 1) Lecture de code ou de fichiers : jamais de réduction (comme avant : début et fin si > 12 000 caractères).
  if (isReader(o.command)) {
    const keep = cleaned
      .split('\n')
      .filter((l) => !/\[[#=>. -]{5,}\]/.test(l))
      .join('\n')
      .trim();
    return { text: clipMiddle(keep, 2500, 9500), mode: 'lecture' };
  }

  const lines = cleaned
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !isNoise(l));

  const failed = o.timedOut || (o.code !== 0 && o.code !== undefined) || Boolean(o.signal);

  // 2) Échec : fiche d'une ligne.
  if (failed) {
    const failure = extractFailure(lines);
    return {
      text: buildFiche({
        failure,
        timedOut: o.timedOut,
        timeoutSec: o.timeoutSec,
        signal: o.signal,
        lines,
      }),
      mode: 'echec',
    };
  }

  // 3) Succès : sortie nettoyée, dédoublonnée et plafonnée.
  const grouped = groupSimilar(lines);
  let text = grouped.join('\n');
  if (text.length > 1800) {
    const omitted = text.length - 1700;
    text = `${text.slice(0, 500)}\n...[${omitted} caractères omis]...\n${text.slice(-1200)}`;
  }
  // La note n'apparaît que si une part notable de la sortie a disparu.
  if (o.logPath && cleaned.trim().length - text.length > 400) {
    text += `\n(sortie réduite, journal complet : /tmp/last.log)`;
  }
  return { text, mode: 'succes' };
}
