import { useEffect, useState } from 'react';
import { request, apiBaseUrl } from 'librechat-data-provider';

type Quota = {
  remaining: number;
  limit: number;
  used: number;
  percent: number;
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
          {quota ? fmt(quota.remaining) : '…'}
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
        <span>{quota ? 'sur ' + fmt(quota.limit) : ''}</span>
      </div>
      {failed && (
        <p className="text-sm text-text-secondary">
          Solde indisponible pour le moment. Nouvel essai dans quelques secondes.
        </p>
      )}
      <p className="border-t border-border-light pt-3 text-xs text-text-secondary">
        Remise à zéro chaque jour.
      </p>
    </div>
  );
}
