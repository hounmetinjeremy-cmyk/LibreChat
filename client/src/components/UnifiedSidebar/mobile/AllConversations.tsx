import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, Search } from 'lucide-react';
import { useConversationsInfiniteQuery } from '~/data-provider';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useAuthContext } from '~/hooks';

const normalize = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/**
 * Lien « Toutes les conversations » (comme dans Claude) : ouvre une page plein écran avec une
 * barre de recherche en haut et tous les titres en lignes pleine largeur. Taper filtre la liste.
 * Le chargement de toutes les pages ne démarre qu'à l'ouverture de la page.
 */
function AllConversations() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthContext();
  const { setSidebarOpen } = useSidebarToggle();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { data, fetchNextPage, isFetchingNextPage, isLoading, isError } =
    useConversationsInfiniteQuery(
      { sortBy: 'updatedAt', sortDirection: 'desc' } as any,
      { enabled: open && isAuthenticated, staleTime: 30000, cacheTime: 300000 } as any,
    );

  const hasNext = useMemo(() => {
    const pages = data?.pages;
    if (!pages || pages.length === 0) {
      return false;
    }
    return pages[pages.length - 1]?.nextCursor != null;
  }, [data?.pages]);

  /** Charge toutes les pages tant qu'il en reste, pour que la recherche couvre tout l'historique. */
  useEffect(() => {
    if (open && hasNext && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [open, hasNext, isFetchingNextPage, isError, fetchNextPage, data]);

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ conversationId: string; title: string }> = [];
    for (const page of data?.pages ?? []) {
      for (const convo of page?.conversations ?? []) {
        if (!convo?.conversationId || seen.has(convo.conversationId)) {
          continue;
        }
        seen.add(convo.conversationId);
        list.push({ conversationId: convo.conversationId, title: convo.title || 'New Chat' });
      }
    }
    return list;
  }, [data?.pages]);

  const filtered = useMemo(() => {
    const needle = normalize(query.trim());
    if (!needle) {
      return conversations;
    }
    return conversations.filter((convo) => normalize(convo.title).includes(needle));
  }, [conversations, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const openConversation = useCallback(
    (conversationId: string) => {
      close();
      navigate(`/c/${conversationId}`);
      setSidebarOpen(false);
    },
    [close, navigate, setSidebarOpen],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  const stillLoading = isLoading || isFetchingNextPage || hasNext;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex flex-shrink-0 items-center gap-1 px-6 pb-1 pt-3 text-left text-base text-text-secondary transition-colors hover:text-text-primary"
      >
        <span>Toutes les conversations</span>
        <ChevronRight className="size-4" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Toutes les conversations"
            className="fixed inset-0 flex flex-col bg-surface-primary text-text-primary"
            style={{
              zIndex: 9999,
              paddingTop: 'env(safe-area-inset-top, 0px)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3 pt-4">
              <button
                type="button"
                onClick={close}
                aria-label="Retour"
                className="flex size-10 flex-shrink-0 items-center justify-center rounded-full text-text-secondary hover:bg-surface-active-alt"
              >
                <ArrowLeft className="size-5" aria-hidden="true" />
              </button>
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-text-secondary"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Rechercher dans vos conversations"
                  aria-label="Rechercher dans vos conversations"
                  className="h-12 w-full rounded-full border border-border-medium bg-surface-primary-alt pl-12 pr-4 text-base text-text-primary outline-none placeholder:text-text-secondary focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
                />
              </div>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              {filtered.map((convo) => (
                <li key={convo.conversationId}>
                  <button
                    type="button"
                    onClick={() => openConversation(convo.conversationId)}
                    className="flex w-full items-center border-b border-border-light px-6 py-4 text-left text-base transition-colors hover:bg-surface-active-alt"
                  >
                    <span className="truncate">{convo.title}</span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="px-6 py-8 text-center text-sm text-text-secondary">
                  {stillLoading ? 'Chargement…' : 'Aucun résultat'}
                </li>
              )}
              {filtered.length > 0 && stillLoading && (
                <li className="px-6 py-4 text-center text-sm text-text-secondary">Chargement…</li>
              )}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

export default memo(AllConversations);
