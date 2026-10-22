import { memo, useEffect, useRef } from 'react';
import { Button, Sidebar } from '@librechat/client';
import type { NavLink } from '~/common';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import { useShortcutAriaKey } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel } from '~/Providers';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import Switcher from './Switcher';

/** Nombre de panneaux affichés comme lignes de menu ; les autres passent par « Plus ». */
const PRIMARY_LINKS = 4;

const MoreIcon = (
  <svg
    className="size-6 flex-shrink-0 text-text-secondary"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

/**
 * En-tête du tiroir mobile, à la manière de Claude : un grand titre, puis les
 * panneaux principaux sous forme de lignes de menu, et un séparateur avant la
 * liste des conversations récentes. Le bouton de fermeture reste dans le DOM
 * (masqué visuellement) car `OpenSidebar` lui rend le focus à l'ouverture ;
 * on ferme aussi en touchant la zone à droite du tiroir ou en glissant.
 */
function Header({
  links,
  expanded,
  onClose,
  onLeaveInsights,
  routeActiveId,
}: {
  links: NavLink[];
  expanded: boolean;
  onClose: () => void;
  onLeaveInsights?: () => void;
  routeActiveId?: string;
}) {
  const localize = useLocalize();
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');
  const closeRef = useRef<HTMLButtonElement>(null);
  const { active, setActive } = useActivePanel();

  const activeId = routeActiveId ?? resolveActivePanel(active, links);
  const primary = links.slice(0, PRIMARY_LINKS);

  /** Opening makes the chat pane inert, so keyboard/AT focus must move into
   * the drawer. The commit itself drives the handoff — every opener (button,
   * swipe, shortcut) lands here, and a wall-clock timer would race the
   * deferred state flip and silently miss whenever the flip outlasted it. */
  useEffect(() => {
    if (expanded) {
      closeRef.current?.focus();
    }
  }, [expanded]);

  const handleLinkClick = (link: NavLink) => {
    if (link.onClick) {
      link.onClick();
      onClose();
      return;
    }
    setActive(link.id);
    if (routeActiveId) {
      onLeaveInsights?.();
    }
  };

  return (
    <div className="flex-shrink-0 px-4" style={{ paddingTop: 'max(2.5rem, env(safe-area-inset-top))' }}>
      <Button
        ref={closeRef}
        id={expanded ? CLOSE_SIDEBAR_ID : undefined}
        data-testid={expanded ? 'close-sidebar-button' : undefined}
        size="icon"
        variant="header-action"
        aria-label={localize('com_nav_close_sidebar')}
        aria-expanded={expanded}
        aria-controls="chat-history-nav"
        aria-keyshortcuts={toggleSidebarAriaKey}
        tabIndex={expanded ? 0 : -1}
        className="sr-only"
        onClick={onClose}
      >
        <Sidebar className="icon-md" aria-hidden="true" />
      </Button>

      <h1 className="px-2 pb-5 font-serif text-[2.4rem] font-normal leading-none tracking-tight text-text-primary">
        LibreChat
      </h1>

      <nav aria-label={localize('com_nav_control_panel')} className="flex flex-col gap-0.5">
        {primary.map((link) => {
          const isActive = link.id === activeId;
          const label = link.id === 'conversations' ? localize('com_ui_chats') : localize(link.title);
          return (
            <button
              key={link.id}
              type="button"
              disabled={link.disabled}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => handleLinkClick(link)}
              className={cn(
                'flex h-12 w-full items-center gap-4 rounded-xl px-3 text-left text-[1.05rem] text-text-primary',
                'transition-colors hover:bg-surface-active-alt disabled:opacity-50',
                isActive && 'bg-surface-active-alt',
              )}
            >
              <link.icon className="size-6 flex-shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        {links.length > PRIMARY_LINKS && (
          <Switcher
            links={links}
            onLeaveInsights={onLeaveInsights}
            onNavigate={onClose}
            routeActiveId={routeActiveId}
            rowLabel="Plus"
            rowIcon={MoreIcon}
          />
        )}
      </nav>

      <div className="mx-2 mb-3 mt-4 border-t border-border-light" />
      {activeId === 'conversations' && (
        <p className="px-3 pb-1 text-sm text-text-secondary">Récents</p>
      )}
    </div>
  );
}

export default memo(Header);
