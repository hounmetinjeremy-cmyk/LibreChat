import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cloud } from 'lucide-react';
import { request, apiBaseUrl } from 'librechat-data-provider';

const LABEL = 'Connecter Cloudflare';

/** Page de création de jeton Cloudflare, déjà remplie (droit « Pages : Edit », nom « Jérémy Code »). */
const TOKEN_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' +
  encodeURIComponent('[{"key":"page","type":"edit"}]') +
  '&accountId=%2A&zoneId=all&name=' +
  encodeURIComponent('Jérémy Code');

/** Autorisation GitHub de Cloudflare Pages : à faire une seule fois, depuis le tableau de bord Cloudflare. */
const GITHUB_AUTH_URL = 'https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages';

type Status = {
  connected?: boolean;
  status?: string;
  reconnect?: boolean;
  account_id_tail?: string;
};
type Account = { id: string; name: string };
type ApiError = { error?: string; message?: string; accounts?: Account[] };

const errData = (e: unknown): ApiError =>
  (e as { response?: { data?: ApiError } } | undefined)?.response?.data || {};

const linkClass =
  'inline-flex w-full items-center justify-center rounded-xl border border-border-light px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover';
const primaryClass =
  'inline-flex w-full items-center justify-center rounded-xl bg-green-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50';
const inputClass =
  'w-full rounded-xl border border-border-light bg-surface-primary px-3 py-2.5 text-sm text-text-primary outline-none focus:border-green-600';

function CloudflareDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [needAccount, setNeedAccount] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus((await request.get(apiBaseUrl() + '/api/cloudflare-link/status')) as Status);
    } catch (e) {
      setStatus({ connected: false });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const connect = async () => {
    if (busy || !token.trim()) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request.post(apiBaseUrl() + '/api/cloudflare-link/connect', {
        token: token.trim(),
        account_id: accountId.trim() || undefined,
      });
      setToken('');
      setAccountId('');
      setNeedAccount(false);
      setReplacing(false);
      await load();
    } catch (e) {
      const d = errData(e);
      if (d.error === 'account_id_required' || d.error === 'account_choice') {
        setNeedAccount(true);
        setAccounts(d.accounts || []);
      }
      setError(d.message || 'Connexion impossible pour le moment.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await request.delete(apiBaseUrl() + '/api/cloudflare-link');
    } catch (e) {
      /* sans effet */
    }
    setReplacing(false);
    await load();
  };

  const connected = Boolean(status && status.connected);
  const showForm = !connected || replacing;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cloudflare"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-surface-primary p-5 text-text-primary shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Cloudflare</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="rounded-lg px-2 py-1 text-xl leading-none text-text-secondary hover:bg-surface-hover"
          >
            ×
          </button>
        </div>

        {status === null && <p className="text-sm text-text-secondary">Chargement…</p>}

        {connected && !replacing && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              Cloudflare est connecté
              {status && status.account_id_tail ? ' (compte …' + status.account_id_tail + ')' : ''}.
            </p>
            <p className="text-sm text-text-secondary">
              Dernière étape, à faire une seule fois : autorise Cloudflare à lire ton GitHub, pour
              republier ton site à chaque modification.
            </p>
            <a href={GITHUB_AUTH_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Autoriser Cloudflare sur GitHub
            </a>
            <button type="button" onClick={() => setReplacing(true)} className={linkClass}>
              Changer de jeton
            </button>
            <button type="button" onClick={disconnect} className={linkClass}>
              Déconnecter Cloudflare
            </button>
          </div>
        )}

        {status !== null && showForm && (
          <div className="flex flex-col gap-3">
            {status.reconnect && (
              <p className="rounded-xl bg-surface-secondary p-3 text-sm">
                Ton jeton Cloudflare n’est plus valide. Crée-en un nouveau pour continuer.
              </p>
            )}
            <p className="text-sm text-text-secondary">
              Pour que je puisse mettre ton site en ligne sur ton compte Cloudflare, il me faut un jeton.
              Ça prend une minute, une seule fois.
            </p>
            <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              1. Créer mon jeton sur Cloudflare
            </a>
            <p className="text-xs text-text-secondary">
              Sur la page qui s’ouvre : touche « Continuer », puis « Créer le jeton », et copie le
              jeton affiché (Cloudflare ne le montre qu’une fois).
            </p>
            <label className="text-sm font-medium" htmlFor="cf-token">
              2. Colle ton jeton ici
            </label>
            <input
              id="cf-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Jeton Cloudflare"
              className={inputClass}
            />
            {needAccount && (
              <div className="flex flex-col gap-2">
                {accounts.length > 0 ? (
                  <>
                    <p className="text-sm">Choisis ton compte Cloudflare :</p>
                    {accounts.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setAccountId(a.id)}
                        className={linkClass + (accountId === a.id ? ' border-green-600' : '')}
                      >
                        {a.name || a.id}
                      </button>
                    ))}
                  </>
                ) : (
                  <>
                    <label className="text-sm font-medium" htmlFor="cf-account">
                      Identifiant de compte
                    </label>
                    <input
                      id="cf-account"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                      placeholder="32 caractères"
                      className={inputClass}
                    />
                    <p className="text-xs text-text-secondary">
                      Tu le trouves dans l’adresse de ton tableau de bord Cloudflare :
                      dash.cloudflare.com/…l’identifiant…/
                    </p>
                  </>
                )}
              </div>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="button" onClick={connect} disabled={busy || !token.trim()} className={primaryClass}>
              {busy ? 'Vérification…' : 'Connecter'}
            </button>
            {replacing && (
              <button type="button" onClick={() => setReplacing(false)} className={linkClass}>
                Annuler
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

type Props = {
  /** inline : bouton dans un message du chat ; row : ligne du tiroir mobile ; icon : barre latérale étroite. */
  variant?: 'inline' | 'row' | 'icon';
};

/**
 * Bouton « Connecter Cloudflare » : ouvre une fenêtre pour coller son jeton Cloudflare (stocké chiffré
 * côté serveur) et autoriser Cloudflare Pages sur GitHub. Le jeton n'est jamais montré à l'IA.
 */
export default function CloudflareConnectButton({ variant = 'row' }: Props) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const dialog = open ? createPortal(<CloudflareDialog onClose={close} />, document.body) : null;

  if (variant === 'icon') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={LABEL}
          title={LABEL}
          data-testid="cloudflare-connect-button"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover"
        >
          <Cloud className="h-5 w-5" aria-hidden="true" />
        </button>
        {dialog}
      </>
    );
  }

  if (variant === 'row') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="cloudflare-connect-button"
          className="flex h-12 w-full items-center gap-4 rounded-xl px-3 text-left text-[1.05rem] text-text-primary transition-colors hover:bg-surface-active-alt"
        >
          <Cloud className="size-6 flex-shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="truncate">Cloudflare</span>
        </button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <span className="my-2 inline-flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="cloudflare-connect-button"
          className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2.5 font-medium text-white transition-colors hover:bg-orange-600"
        >
          <Cloud className="h-5 w-5" aria-hidden="true" />
          {LABEL}
        </button>
      </span>
      {dialog}
    </>
  );
}
