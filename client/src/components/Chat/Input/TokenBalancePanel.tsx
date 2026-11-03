import { useEffect, useState } from 'react';
import { request, apiBaseUrl } from 'librechat-data-provider';

type Quota = {
  remaining: number;
  limit: number;
  used: number;
  percent: number;
  wallet?: boolean;
  remaining_usd?: number;
  limit_usd?: number;
  plan?: string;
  tasks_estimate?: number;
  unlimited?: boolean;
  terminal_ok?: boolean;
};

type Rates = Record<string, number>;

const CFA = ['XOF', 'XAF'];
const EURO_ZONES = ['Europe/Paris', 'Europe/Brussels', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Rome', 'Europe/Lisbon'];
const TZ_CUR: Record<string, string> = {
  'Africa/Porto-Novo': 'XOF', 'Africa/Abidjan': 'XOF', 'Africa/Dakar': 'XOF', 'Africa/Lome': 'XOF',
  'Africa/Ouagadougou': 'XOF', 'Africa/Bamako': 'XOF', 'Africa/Niamey': 'XOF',
  'Africa/Douala': 'XAF', 'Africa/Libreville': 'XAF', 'Africa/Brazzaville': 'XAF', 'Africa/Bangui': 'XAF',
  'Africa/Ndjamena': 'XAF', 'Africa/Lagos': 'NGN', 'Africa/Accra': 'GHS', 'Africa/Casablanca': 'MAD',
  'Europe/London': 'GBP', 'Europe/Zurich': 'CHF', 'America/Toronto': 'CAD', 'America/Montreal': 'CAD',
  'America/Vancouver': 'CAD', 'America/Sao_Paulo': 'BRL',
};

/** Monnaie locale : choix manuel (mémorisé) sinon déduite du fuseau horaire, sinon dollar. */
const detectCurrency = (): string => {
  try {
    const saved = localStorage.getItem('wallet_currency');
    if (saved) return saved;
  } catch (e) {
    /* stockage indisponible */
  }
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (TZ_CUR[tz]) return TZ_CUR[tz];
    if (EURO_ZONES.includes(tz) || tz.startsWith('Europe/')) return 'EUR';
  } catch (e) {
    /* ignore */
  }
  return 'USD';
};

const money = (usd: number, cur: string, rates: Rates) => {
  const v = usd * (rates[cur] || 1);
  const noDec = CFA.includes(cur);
  const label = cur === 'XOF' || cur === 'XAF' ? 'FCFA' : cur;
  const num = new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: noDec ? 0 : 2,
    maximumFractionDigits: noDec ? 0 : 2,
  }).format(noDec ? Math.round(v) : v);
  return `${num} ${cur === 'EUR' ? '€' : cur === 'USD' ? '$' : label}`;
};

const REFRESH_MS = 10000;

const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(Math.max(0, Math.round(n)));

/**
 * Écran « Tokens » du menu + : solde de tokens restant aujourd’hui, avec une barre horizontale.
 * Il interroge /api/sandbox-job/quota toutes les 10 secondes tant qu’il est affiché.
 */
export default function TokenBalancePanel() {
  const [quota, setQuota] = useState<Quota | null>(null);
  const [failed, setFailed] = useState(false);
  const [rates, setRates] = useState<Rates>({ USD: 1 });
  const [cur, setCur] = useState<string>(detectCurrency);

  useEffect(() => {
    (async () => {
      try {
        const r = (await request.get(apiBaseUrl() + '/api/sandbox-job/rates')) as { rates?: Rates };
        if (r?.rates) setRates(r.rates);
      } catch (e) {
        /* taux de secours : dollar */
      }
    })();
  }, []);

  const changeCur = (c: string) => {
    setCur(c);
    try {
      localStorage.setItem('wallet_currency', c);
    } catch (e) {
      /* ignore */
    }
  };

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = (await request.get(apiBaseUrl() + '/api/sandbox-job/quota')) as Quota;
        if (stopped) {
          return;
        }
        setQuota(data);
        setFailed(false);
      } catch (e) {
        if (stopped) {
          return;
        }
        setFailed(true);
      }
      timer = setTimeout(tick, REFRESH_MS);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const pct = quota ? Math.min(100, Math.max(0, Math.round(quota.percent))) : 0;

  return (
    <div
      className="flex flex-col gap-4 rounded-2xl bg-surface-secondary p-4"
      data-testid="token-balance"
    >
      <div>
        <p className="text-sm text-text-secondary">Solde du jour</p>
        <p className="text-3xl font-semibold text-text-primary">
          {!quota ? '…' : quota.wallet ? (quota.unlimited ? 'Illimité (test)' : money(quota.remaining_usd || 0, cur, rates)) : fmt(quota.remaining)}
        </p>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Solde de tokens restant"
        className="h-2.5 w-full overflow-hidden rounded-full bg-surface-tertiary"
      >
        <div
          className="h-full rounded-full bg-blue-600 transition-all"
          style={{ width: pct + '%' }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-text-secondary">
        <span>{quota ? pct + ' % restant' : ''}</span>
        <span>{quota ? (quota.wallet ? (quota.unlimited ? '' : 'sur ' + money(quota.limit_usd || 0, cur, rates)) : 'sur ' + fmt(quota.limit)) : ''}</span>
      </div>
      {failed && (
        <p className="text-sm text-text-secondary">
          Solde indisponible pour le moment. Nouvel essai dans quelques secondes.
        </p>
      )}
      {quota?.wallet && !quota.unlimited && (quota.tasks_estimate || 0) > 0 && (
        <p className="text-xs text-text-secondary">
          Environ {quota.tasks_estimate} tâche(s) du terminal possible(s) avec ce solde.
        </p>
      )}
      {quota?.wallet && quota.terminal_ok === false && (
        <p className="text-xs text-text-secondary">
          Le terminal est réservé aux abonnés. Le chat reste utilisable avec ton solde gratuit.
        </p>
      )}
      <div className="flex items-center justify-between border-t border-border-light pt-3 text-xs text-text-secondary">
        <span>Un seul solde pour le chat, les outils et le terminal. Remise à zéro chaque jour.</span>
        <select
          aria-label="Monnaie"
          value={cur}
          onChange={(e) => changeCur(e.target.value)}
          className="ml-2 rounded bg-surface-tertiary px-1 py-0.5"
        >
          {['EUR', 'USD', 'XOF', 'XAF', 'GBP', 'CAD', 'CHF', 'MAD', 'NGN', 'GHS', 'BRL'].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
