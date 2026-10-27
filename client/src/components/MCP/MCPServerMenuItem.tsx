import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import * as Ariakit from '@ariakit/react';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import type { MCPServerStatusIconProps } from './MCPServerStatusIcon';
import { shouldShowActionButton, type ConnectionStatusMap } from './mcpServerUtils';
import MCPServerStatusIcon from './MCPServerStatusIcon';
import { cn } from '~/utils';

interface MCPServerMenuItemProps {
  server: MCPServerDefinition;
  connectionStatus?: ConnectionStatusMap;
  statusIconProps?: MCPServerStatusIconProps | null;
  /** Nombre d'outils (permissions) exposés par le serveur, affiché quand il est connecté */
  toolCount?: number;
  /** Logo fourni par le serveur MCP lui-même (champ icon), s'il existe */
  iconUrl?: string;
  onOpen: (serverName: string) => void;
}

function getLogoCandidates(server: MCPServerDefinition, iconUrl?: string): string[] {
  const candidates: string[] = [];
  if (server.config?.iconPath) {
    candidates.push(server.config.iconPath);
  }
  if (iconUrl) {
    candidates.push(iconUrl);
  }
  const url = (server.config as { url?: string } | undefined)?.url;
  if (url) {
    try {
      const host = new URL(url).hostname;
      // Favicon du site du serveur (repli automatique)
      candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=128`);
    } catch {
      /* URL invalide : on ignore */
    }
  }
  return candidates;
}

function ServerLogo({ candidates, name }: { candidates: string[]; name: string }) {
  const [index, setIndex] = useState(0);
  const src = candidates[index];

  if (!src) {
    return (
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border-light bg-surface-tertiary text-sm font-medium text-text-secondary">
        {name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="h-9 w-9 rounded-lg border border-border-light bg-white object-contain p-1"
      onError={() => setIndex((i) => i + 1)}
    />
  );
}

export default function MCPServerMenuItem({
  server,
  connectionStatus,
  statusIconProps,
  toolCount,
  iconUrl,
  onOpen,
}: MCPServerMenuItemProps) {
  const displayName = server.config?.title || server.serverName;
  const isConnected = connectionStatus?.[server.serverName]?.connectionState === 'connected';
  const showActionButton = shouldShowActionButton(statusIconProps);
  const candidates = getLogoCandidates(server, iconUrl);

  return (
    <Ariakit.MenuItem
      hideOnClick={false}
      onClick={() => onOpen(server.serverName)}
      aria-label={
        isConnected && toolCount != null ? `${displayName}, ${toolCount}` : displayName
      }
      className={cn(
        'group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2',
        'outline-none transition-all duration-150',
        'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
      )}
    >
      <div className="flex-shrink-0">
        <ServerLogo candidates={candidates} name={displayName} />
      </div>

      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{displayName}</span>
        {server.config?.description && (
          <p className="truncate text-xs text-text-secondary">{server.config.description}</p>
        )}
      </div>

      {isConnected ? (
        <span className="flex-shrink-0 rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-semibold text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
          {toolCount ?? 0}
        </span>
      ) : showActionButton && statusIconProps ? (
        <div className="flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <MCPServerStatusIcon {...statusIconProps} />
        </div>
      ) : (
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
      )}
    </Ariakit.MenuItem>
  );
}
