import { memo, lazy, Suspense, useCallback } from 'react';
import { useRecoilValue } from 'recoil';
import { Plus } from 'lucide-react';
import { Button, Skeleton } from '@librechat/client';
import type { NavLink } from '~/common';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import { useShortcutAriaKey } from '~/hooks/useKeyboardShortcuts';
import SearchBar from '~/components/Nav/SearchBar';
import useNewChat from '~/hooks/Chat/useNewChat';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';
import AllConversations from './AllConversations';

const AccountSettings = lazy(() => import('~/components/Nav/AccountSettings'));

/**
 * Pied du tiroir, à la manière de Claude : le compte à gauche (rond), puis le
 * bouton « Nouvelle conversation » en pastille noire. Un pied flex plutôt
 * qu'une surcouche, pour que la liste virtualisée se réduise autour de lui et
 * ne soit jamais masquée.
 */
function BottomBar({
  links,
  onNewChat,
}: {
  links: NavLink[];
  onNewChat: (afterSlide?: () => void) => void;
}) {
  const localize = useLocalize();
  const search = useRecoilValue(store.search);
  const switchToHistory = useRecoilValue(store.newChatSwitchToHistory);
  const { active, setActive } = useActivePanel();

  const { startNewChat } = useNewChat();

  /**
   * Close first, reset second — inverted from `useNewChat`'s own click
   * handler: `startNewChat` clears the message cache and resets the
   * conversation, and run synchronously that commit stalls the drawer
   * slide's first frame on large conversations. The reset (and the panel
   * switch-back) ride the close's `afterSlide` instead, landing mid-slide.
   * The modified-click guard mirrors `useNewChat.handleNewChatClick` so a
   * ctrl/middle click still opens `/c/new` in a new tab.
   */
  const handleNewChatClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      onNewChat(() => {
        if (switchToHistory) {
          setActive(DEFAULT_PANEL);
        }
        startNewChat();
      });
    },
    [onNewChat, switchToHistory, setActive, startNewChat],
  );
  /** The shortcut fires globally; assistive tech needs it discoverable here too. */
  const newChatAriaKey = useShortcutAriaKey('newChat');

  /** Searching messages only means anything from the conversation list. */
  const showSearch = search.enabled === true && resolveActivePanel(active, links) === DEFAULT_PANEL;
  /** Lien « Toutes les conversations » : seulement sur le panneau des conversations. */
  const showAll = resolveActivePanel(active, links) === DEFAULT_PANEL;

  return (
    <>
      {showAll && <AllConversations />}
      <div
        className="flex flex-shrink-0 items-center gap-3 px-4 pt-2"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <div className="flex-shrink-0" data-testid="drawer-account">
          <Suspense fallback={<Skeleton className="size-[52px] rounded-full" />}>
            <AccountSettings collapsed />
          </Suspense>
        </div>
        {showSearch && (
          <div className="min-w-0 flex-1">
            <SearchBar isSmallScreen={true} />
          </div>
        )}
        <Button
          asChild
          className={cn('h-[52px] gap-2 rounded-full', showSearch ? 'flex-shrink-0 px-5' : 'min-w-0 flex-1')}
        >
          <a
            href="/c/new"
            data-testid="nav-new-chat-fab"
            aria-label={localize('com_ui_new_chat')}
            aria-keyshortcuts={newChatAriaKey}
            onClick={handleNewChatClick}
          >
            <Plus className="size-5" aria-hidden="true" />
            <span className="truncate text-base font-medium">{localize('com_ui_new_chat')}</span>
          </a>
        </Button>
      </div>
    </>
  );
}

export default memo(BottomBar);
