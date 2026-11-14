import { useEffect, useState } from 'react';
import { request, apiBaseUrl } from 'librechat-data-provider';

type Totals = {
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
  costed: number;
};
type Mine = { today: Totals; last7: Totals; last30: Totals; admin: boolean };
type Row = Totals & { user: string; email: string };
type All = {
  days: number;
  users: Row[];
  total: Totals;
  credits: { total: number; used: number; remaining: number } | null;
};

const REFRESH_MS = 15000;
const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(Math.max(0, Math.round(n || 0)));
const usd = (n: number) =>
  '$' + new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n || 0);

/**
 * Consommation RÉELLE lue dans les réponses d'OpenRouter (tokens et coût facturé), sous le solde du jour.
 * L'administrateur voit en plus une ligne par utilisateur et le solde du compte OpenRouter.
 */
export default function TokenRealUsage() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [all, setAll] = useState<All | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const m = (await request.get(apiBaseUrl() + '/api/or-usage/me')) as Mine;
        if (stopped) {
          return;
        }
        setMine(m);
        setFailed(false);
        if (m.admin) {
          const a = (await request.get(apiBaseUrl() + '/api/or-usage/all?days=7')) as All;
          if (!stopped) {
            setAll(a);
          }
        }
      } catch (e) {
        if (!stopped) {
          setFailed(true);
        }
      }
      if (!stopped) {
        timer = setTimeout(tick, REFRESH_MS);
      }
    };
    tick();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  const line = (label: string, t: Totals) => (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-text-primary">
        {t.costed > 0 ? usd(t.cost) : '—'} · {fmt(t.prompt + t.completion)} tokens · {fmt(t.requests)} appel(s)
      </span>
    </div>
  );

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-2xl bg-surface-secondary p-4"
      data-testid="token-real-usage"
    >
      <p className="text-sm font-medium text-text-primary">Consommation réelle (OpenRouter)</p>
      {!mine && !failed && <p className="text-xs text-text-secondary">…</p>}
      {failed && !mine && (
        <p className="text-xs text-text-secondary">Indisponible pour le moment.</p>
      )}
      {mine && (
        <>
          {line("Aujourd'hui", mine.today)}
          {line('7 jours', mine.last7)}
          {line('30 jours', mine.last30)}
          <p className="text-xs text-text-secondary">
            Entrée {fmt(mine.today.prompt)} (dont {fmt(mine.today.cached)} en cache) · sortie{' '}
            {fmt(mine.today.completion)} aujourd'hui. Le coût est celui facturé par OpenRouter.
          </p>
        </>
      )}
      {all && (
        <div className="flex flex-col gap-2 border-t border-border-light pt-3">
          <p className="text-sm font-medium text-text-primary">Tous les utilisateurs ({all.days} jours)</p>
          {all.credits && (
            <p className="text-xs text-text-secondary">
              Compte OpenRouter : {usd(all.credits.remaining)} restants sur {usd(all.credits.total)} (
              {usd(all.credits.used)} utilisés)
            </p>
          )}
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-secondary">
                <tr>
                  <th className="pb-1 pr-2 font-normal">Utilisateur</th>
                  <th className="pb-1 pr-2 text-right font-normal">Appels</th>
                  <th className="pb-1 pr-2 text-right font-normal">Tokens</th>
                  <th className="pb-1 text-right font-normal">Coût</th>
                </tr>
              </thead>
              <tbody className="text-text-primary">
                {all.users.map((u) => (
                  <tr key={u.user}>
                    <td className="max-w-[9rem] truncate py-0.5 pr-2" title={u.email || u.user}>
                      {u.email || u.user}
                    </td>
                    <td className="py-0.5 pr-2 text-right">{fmt(u.requests)}</td>
                    <td className="py-0.5 pr-2 text-right">{fmt(u.prompt + u.completion)}</td>
                    <td className="py-0.5 text-right">{u.costed > 0 ? usd(u.cost) : '—'}</td>
                  </tr>
                ))}
                <tr className="border-t border-border-light font-medium">
                  <td className="pt-1 pr-2">Total</td>
                  <td className="pt-1 pr-2 text-right">{fmt(all.total.requests)}</td>
                  <td className="pt-1 pr-2 text-right">{fmt(all.total.prompt + all.total.completion)}</td>
                  <td className="pt-1 text-right">{usd(all.total.cost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
