import { useState } from 'react';
import { Code } from 'lucide-react';
import { request, apiBaseUrl } from 'librechat-data-provider';

const LABEL = 'Jérémy Code';

type Props = {
  /** inline : bouton dans un message du chat ; row : ligne du tiroir mobile ; icon : barre latérale étroite. */
  variant?: 'inline' | 'row' | 'icon';
  /** Lien de connexion déjà signé (fourni par l'IA dans le chat). Sinon on le demande au serveur. */
  href?: string;
  onDone?: () => void;
};

/**
 * Bouton « Jérémy Code » : connecte le compte GitHub de l'utilisateur en un seul appui.
 * Il ouvre la connexion GitHub ; au retour, le terminal retrouve le compte tout seul.
 */
export default function JeremyCodeButton({ variant = 'row', href, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const go = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      let url = href;
      if (!url) {
        const data = (await request.get(apiBaseUrl() + '/api/sandbox-job/github-connect')) as {
          url?: string;
        };
        url = data && data.url ? data.url : undefined;
        if (url && url.startsWith('/')) {
          url = apiBaseUrl() + url;
        }
      }
      if (!url) {
        throw new Error('lien absent');
      }
      if (onDone) {
        onDone();
      }
      window.location.assign(url);
    } catch (e) {
      setFailed(true);
      setBusy(false);
    }
  };

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={go}
        disabled={busy}
        aria-label={LABEL}
        title={LABEL}
        data-testid="jeremy-code-button"
        className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
      >
        <Code className="h-5 w-5" aria-hidden="true" />
      </button>
    );
  }

  if (variant === 'row') {
    return (
      <button
        type="button"
        onClick={go}
        disabled={busy}
        data-testid="jeremy-code-button"
        className="flex h-12 w-full items-center gap-4 rounded-xl px-3 text-left text-[1.05rem] text-text-primary transition-colors hover:bg-surface-active-alt disabled:opacity-50"
      >
        <Code className="size-6 flex-shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="truncate">{failed ? 'Réessayer : ' + LABEL : LABEL}</span>
      </button>
    );
  }

  return (
    <span className="my-2 inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={go}
        disabled={busy}
        data-testid="jeremy-code-button"
        className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-green-700 disabled:opacity-50"
      >
        <Code className="h-5 w-5" aria-hidden="true" />
        {LABEL}
      </button>
      {failed && (
        <span className="text-sm text-text-secondary">Impossible pour le moment, réessaie.</span>
      )}
    </span>
  );
}
