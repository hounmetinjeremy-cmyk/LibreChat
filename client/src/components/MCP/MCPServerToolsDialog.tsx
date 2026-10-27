import { X } from 'lucide-react';

export interface MCPToolInfo {
  name: string;
  pluginKey?: string;
  description?: string;
}

interface MCPServerToolsDialogProps {
  displayName: string;
  tools: MCPToolInfo[];
  onClose: () => void;
}

export default function MCPServerToolsDialog({
  displayName,
  tools,
  onClose,
}: MCPServerToolsDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 sm:items-center"
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
