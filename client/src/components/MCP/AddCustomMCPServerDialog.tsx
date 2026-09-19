import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Input,
  Label,
  Button,
  Switch,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  OGDialogFooter,
} from '@librechat/client';
import { useLocalize } from '~/hooks';

interface AddCustomMCPServerDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Called after the server was created successfully on the backend. */
  onCreated?: () => void;
}

/**
 * "Ajouter un connecteur personnalisé" — lets any user with MCP create
 * permission register their own MCP server (Name + URL + optional OAuth),
 * without needing an admin to touch librechat.yaml.
 *
 * POSTs to the existing, already-implemented backend route:
 *   POST /api/mcp/servers  { name, url, requiresOAuth }
 * (see api/server/routes/mcp.js — "MCP Server CRUD Routes (User-Managed MCP Servers)")
 */
export default function AddCustomMCPServerDialog({
  isOpen,
  onOpenChange,
  onCreated,
}: AddCustomMCPServerDialogProps) {
  const localize = useLocalize();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [requiresOAuth, setRequiresOAuth] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetAndClose = () => {
    setName('');
    setUrl('');
    setRequiresOAuth(false);
    setError(null);
    onOpenChange(false);
  };

  const canSubmit = name.trim().length > 0 && url.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const token =
        typeof window !== 'undefined' ? window.localStorage.getItem('token') : null;
      const response = await fetch('/api/mcp/servers', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          requiresOAuth,
          type: 'streamable-http',
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}) as { error?: string });
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      onCreated?.();
      resetAndClose();
      // Force a refresh so the new connector shows up immediately in the "+" menu.
      // A follow-up pass can replace this with a targeted query invalidation once
      // the exact React Query key used by useMCPServerManager is confirmed.
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <OGDialog open={isOpen} onOpenChange={(open) => (open ? onOpenChange(true) : resetAndClose())}>
      <OGDialogContent className="w-11/12 max-w-md overflow-hidden rounded-2xl">
        <OGDialogHeader>
          <OGDialogTitle>Ajouter un connecteur personnalisé</OGDialogTitle>
        </OGDialogHeader>

        <div className="flex flex-col gap-4 p-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-mcp-name">Nom</Label>
            <Input
              id="custom-mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-mcp-url">URL du serveur MCP</Label>
            <Input
              id="custom-mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="URL du serveur MCP"
              dir="ltr"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border-light p-3">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-text-primary">Connexion requise</span>
              <span className="text-xs text-text-secondary">
                Activez cette option si le serveur utilise OAuth.
              </span>
            </div>
            <Switch checked={requiresOAuth} onCheckedChange={setRequiresOAuth} />
          </div>

          <div className="flex items-start gap-2 rounded-lg bg-status-warning-subtle p-3 text-xs text-status-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              N&apos;utilisez que des connecteurs provenant de développeurs en qui vous avez
              confiance. Le fournisseur de cette application ne contrôle pas les outils que les
              développeurs mettent à disposition et ne peut pas garantir qu&apos;ils sont sûrs.
            </span>
          </div>

          {error && <p className="text-xs text-status-error">{error}</p>}
        </div>

        <OGDialogFooter>
          <Button type="button" variant="outline" onClick={resetAndClose}>
            {localize('com_ui_cancel')}
          </Button>
          <Button type="button" variant="submit" disabled={!canSubmit} onClick={handleSubmit}>
            {isSubmitting ? '...' : 'Ajouter'}
          </Button>
        </OGDialogFooter>
      </OGDialogContent>
    </OGDialog>
  );
}
