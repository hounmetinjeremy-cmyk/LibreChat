import { Unplug, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';

export interface MCPToolInfo {
  name: string;
  pluginKey?: string;
  description?: string;
}

interface MCPServerToolsDialogProps {
  displayName: string;
  tools: MCPToolInfo[];
  /** Nom technique du serveur : nécessaire pour afficher le bouton Déconnecter */
  serverName?: string;
  /** Appelé après une déconnexion réussie (avant la fermeture) */
  onDisconnected?: () => void;
  onClose: () => void;
}

export default function MCPServerToolsDialog({
  displayName,
  tools,
  serverName,
  onDisconnected,
  onClose,
}: MCPServerToolsDialogProps) {
  const queryClient = useQueryClient();
  const disconnectMutation = useUpdateUserPluginsMutation({
    onSuccess: async () => {
      onDisconnected?.();
      await Promise.all([
        queryClient.invalidateQueries([QueryKeys.mcpServers]),
        queryClient.invalidateQueries([QueryKeys.mcpTools]),
        queryClient.invalidateQueries([QueryKeys.mcpAuthValues]),
        queryClient.invalidateQueries([QueryKeys.mcpConnectionStatus]),
      ]);
      onClose();
    },
    onError: (error: unknown) => {
      console.error('Error disconnecting MCP server:', error);
    },
  });

  const handleDisconnect = () => {
    if (!serverName) {
      return;
    }
    disconnectMutation.mutate({
      pluginKey: `${Constants.mcp_prefix}${serverName}`,
      action: 'uninstall',
      auth: {},
    });
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={displayName}
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-t-2xl bg-presentation shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-light px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-text-primary">{displayName}</h2>
            <p className="text-xs text-text-secondary">{tools.length}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 hover:bg-surface-hover"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {serverName && (
          <div className="border-b border-border-light px-4 py-3">
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnectMutation.isLoading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60 dark:bg-red-900/30 dark:text-red-300"
            >
              <Unplug className="h-4 w-4" aria-hidden="true" />
              Déconnecter
            </button>
          </div>
        )}
        <ul className="flex-1 overflow-y-auto p-2">
          {tools.map((tool) => (
            <li key={tool.pluginKey ?? tool.name} className="rounded-lg px-3 py-2">
              <p className="text-sm font-medium text-text-primary">{tool.name}</p>
              {tool.description && (
                <p className="mt-0.5 line-clamp-3 text-xs text-text-secondary">{tool.description}</p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
