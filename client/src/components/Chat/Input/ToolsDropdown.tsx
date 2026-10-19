import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TooltipAnchor, VectorIcon, MCPIcon } from '@librechat/client';
import {
  Blocks,
  Brain,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  FileUp,
  Globe,
  Image as ImageIcon,
  Plus,
  ScrollText,
  Settings,
  WandSparkles,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  AuthType,
  Permissions,
  ArtifactModes,
  PermissionTypes,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import {
  useLocalize,
  useHasAccess,
  useAuthContext,
  useHasMemoryAccess,
  useAgentCapabilities,
} from '~/hooks';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import AddCustomMCPServerDialog from '~/components/MCP/AddCustomMCPServerDialog';
import { useBadgeRowContext } from '~/Providers';
import { cn } from '~/utils';

interface ToolsDropdownProps {
  disabled?: boolean;
}

type MenuView = 'root' | 'artifacts' | 'mcp';

/** Ouvre le menu d'envoi de fichiers existant (trombone), sans le dupliquer. */
const openExistingAttachMenu = () => {
  const trigger =
    document.getElementById('attach-file-menu-button') ??
    document.getElementById('attach-file-button');
  trigger?.click();
};

/** Interrupteur à la manière de Claude : bleu quand c'est activé. */
const ToggleSwitch = ({ checked }: { checked: boolean }) => (
  <span
    className={cn(
      'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
      checked ? 'bg-blue-600' : 'bg-surface-tertiary',
    )}
    aria-hidden="true"
  >
    <span
      className={cn(
        'inline-block size-5 transform rounded-full bg-white shadow transition-transform',
        checked ? 'translate-x-5' : 'translate-x-0.5',
      )}
    />
  </span>
);

/** Une ligne de la feuille : icône dans un rond, libellé, élément à droite. */
const ToolRow = ({
  Icon,
  label,
  right,
}: {
  Icon: LucideIcon | React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  right?: React.ReactNode;
}) => (
  <div className="flex w-full items-center gap-3 py-2">
    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-tertiary">
      <Icon className="size-5" aria-hidden={true} />
    </span>
    <span className="flex-1 text-left text-base text-text-primary">{label}</span>
    {right}
  </div>
);

const ToolsDropdown = ({ disabled }: ToolsDropdownProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const context = useBadgeRowContext();

  const {
    codeEnabled,
    memoryEnabled,
    webSearchEnabled,
    artifactsEnabled,
    fileSearchEnabled,
    skillsEnabled,
  } = useAgentCapabilities(context?.agentsConfig?.capabilities ?? defaultAgentCapabilities);

  const canUseWebSearch = useHasAccess({
    permissionType: PermissionTypes.WEB_SEARCH,
    permission: Permissions.USE,
  });

  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });

  const canUseFileSearch = useHasAccess({
    permissionType: PermissionTypes.FILE_SEARCH,
    permission: Permissions.USE,
  });

  const canUseMcp = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });

  const canUseSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });

  const canUseMemory = useHasMemoryAccess();
  const showMemory = canUseMemory && memoryEnabled && user?.personalization?.memories !== false;

  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<MenuView>('root');
  const [isAddCustomOpen, setIsAddCustomOpen] = useState(false);
  const [isConnectorsMenuOpen, setIsConnectorsMenuOpen] = useState(false);
  const isDisabled = disabled ?? false;

  const {
    skills,
    memory,
    webSearch,
    artifacts,
    fileSearch,
    mcpServerManager,
    codeInterpreter,
    searchApiKeyForm,
    storageContextKey,
  } = context ?? {};

  const { setIsDialogOpen: setIsSearchDialogOpen, menuTriggerRef: searchMenuTriggerRef } =
    searchApiKeyForm ?? {};
  const { authData: webSearchAuthData } = webSearch ?? {};

  const selectableServers = mcpServerManager?.selectableServers ?? [];

  /** Exécution de code : activée automatiquement, comme dans Claude, sans ligne dans le menu.
   *  Une seule fois par montage, pour ne pas boucler si la valeur ne se met pas à jour tout de suite. */
  const autoEnabledRef = useRef(false);
  useEffect(() => {
    if (autoEnabledRef.current) {
      return;
    }
    if (!canRunCode || !codeEnabled || !codeInterpreter) {
      return;
    }
    autoEnabledRef.current = true;
    if (!codeInterpreter.toggleState) {
      codeInterpreter.debouncedChange({ value: true });
    }
  }, [canRunCode, codeEnabled, codeInterpreter]);

  /** Rafraîchit la liste des connecteurs tant que la feuille est ouverte. */
  useMCPRefresh({
    enabled: isOpen && view === 'mcp' && selectableServers.length > 0,
  });

  /** Quand la feuille se ferme, on revient toujours à la liste principale. */
  useEffect(() => {
    if (!isOpen) {
      setView('root');
      setIsConnectorsMenuOpen(false);
    }
  }, [isOpen]);

  /** Escape ferme la feuille. */
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const showWebSearchSettings = useMemo(() => {
    const authTypes = webSearchAuthData?.authTypes ?? [];
    if (authTypes.length === 0) return true;
    return !authTypes.every(([, authType]) => authType === AuthType.SYSTEM_DEFINED);
  }, [webSearchAuthData?.authTypes]);

  const handleWebSearchToggle = useCallback(() => {
    const newValue = !webSearch?.toggleState;
    webSearch?.debouncedChange({ value: newValue });
  }, [webSearch]);

  const handleFileSearchToggle = useCallback(() => {
    const newValue = !fileSearch?.toggleState;
    fileSearch?.debouncedChange({ value: newValue });
  }, [fileSearch]);

  const handleArtifactsToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (!currentState || currentState === '') {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: '' });
    }
  }, [artifacts]);

  const handleShadcnToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (currentState === ArtifactModes.SHADCNUI) {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: ArtifactModes.SHADCNUI });
    }
  }, [artifacts]);

  const handleCustomToggle = useCallback(() => {
    const currentState = artifacts?.toggleState;
    if (currentState === ArtifactModes.CUSTOM) {
      artifacts?.debouncedChange({ value: ArtifactModes.DEFAULT });
    } else {
      artifacts?.debouncedChange({ value: ArtifactModes.CUSTOM });
    }
  }, [artifacts]);

  const handleSkillsToggle = useCallback(() => {
    const newValue = !skills?.toggleState;
    skills?.debouncedChange({ value: newValue });
  }, [skills]);

  const handleMemoryToggle = useCallback(() => {
    const newValue = !memory?.toggleState;
    memory?.debouncedChange({ value: newValue });
  }, [memory]);

  /** Trois raccourcis en haut de la feuille, comme dans l'application Claude. */
  const attachTiles = [
    { id: 'camera', label: 'Appareil photo', Icon: Camera },
    { id: 'photos', label: 'Photos', Icon: ImageIcon },
    { id: 'files', label: 'Fichiers', Icon: FileUp },
  ];

  /** Lignes de la liste principale. */
  const rootRows: React.ReactNode[] = [];

  if (canUseWebSearch && webSearchEnabled) {
    rootRows.push(
      <div key="web-search" data-testid="tools-menu-web-search" className="flex w-full items-center gap-2">
        <button
          type="button"
          onClick={handleWebSearchToggle}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-tertiary">
            <Globe className="size-5" aria-hidden="true" />
          </span>
          <span className="flex-1 text-base text-text-primary">{localize('com_ui_web_search')}</span>
        </button>
        {showWebSearchSettings && (
          <button
            type="button"
            onClick={() => setIsSearchDialogOpen?.(true)}
            className="rounded-full p-2 text-text-secondary hover:bg-surface-hover"
            aria-label="Configure web search"
            ref={searchMenuTriggerRef}
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={!!webSearch?.toggleState}
          onClick={handleWebSearchToggle}
          aria-label={localize('com_ui_web_search')}
        >
          <ToggleSwitch checked={!!webSearch?.toggleState} />
        </button>
      </div>,
    );
  }

  if (fileSearchEnabled && canUseFileSearch) {
    rootRows.push(
      <button
        key="file-search"
        type="button"
        role="switch"
        aria-checked={!!fileSearch?.toggleState}
        data-testid="tools-menu-file-search"
        onClick={handleFileSearchToggle}
        className="flex w-full items-center gap-3 text-left"
      >
        <ToolRow
          Icon={VectorIcon}
          label={localize('com_assistants_file_search')}
          right={<ToggleSwitch checked={!!fileSearch?.toggleState} />}
        />
      </button>,
    );
  }

  if (canUseSkills && skillsEnabled) {
    rootRows.push(
      <button
        key="skills"
        type="button"
        role="switch"
        aria-checked={!!skills?.toggleState}
        data-testid="tools-menu-skills"
        onClick={handleSkillsToggle}
        className="flex w-full items-center gap-3 text-left"
      >
        <ToolRow
          Icon={ScrollText}
          label={localize('com_ui_skills')}
          right={<ToggleSwitch checked={!!skills?.toggleState} />}
        />
      </button>,
    );
  }

  if (showMemory) {
    rootRows.push(
      <button
        key="memory"
        type="button"
        role="switch"
        aria-checked={!!memory?.toggleState}
        data-testid="tools-menu-memory"
        onClick={handleMemoryToggle}
        className="flex w-full items-center gap-3 text-left"
      >
        <ToolRow
          Icon={Brain}
          label={localize('com_ui_memory')}
          right={<ToggleSwitch checked={!!memory?.toggleState} />}
        />
      </button>,
    );
  }

  if (artifactsEnabled && artifacts) {
    rootRows.push(
      <button
        key="artifacts"
        type="button"
        data-testid="tools-menu-artifacts"
        onClick={() => setView('artifacts')}
        className="flex w-full items-center gap-3 text-left"
      >
        <ToolRow
          Icon={WandSparkles}
          label="Artefacts"
          right={<ChevronRight className="size-5 text-text-secondary" aria-hidden="true" />}
        />
      </button>,
    );
  }

  if (canUseMcp && mcpServerManager) {
    rootRows.push(
      <button
        key="connectors"
        type="button"
        data-testid="tools-menu-mcp"
        onClick={() => setView('mcp')}
        className="flex w-full items-center gap-3 text-left"
      >
        <ToolRow
          Icon={Blocks}
          label="Connecteurs"
          right={<ChevronRight className="size-5 text-text-secondary" aria-hidden="true" />}
        />
      </button>,
    );
  }

  /** Panneau Artefacts : remplace la liste, avec une flèche retour. */
  const artifactsPanel = (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={!!artifacts?.toggleState}
        onClick={handleArtifactsToggle}
        className="flex w-full items-center justify-between rounded-lg px-2 py-3 text-base hover:bg-surface-hover"
      >
        <span>Activer les artefacts</span>
        <ToggleSwitch checked={!!artifacts?.toggleState} />
      </button>
      <button
        type="button"
        onClick={handleShadcnToggle}
        className="flex w-full items-center justify-between rounded-lg px-2 py-3 text-base hover:bg-surface-hover"
      >
        <span>Inclure shadcn/ui</span>
        {artifacts?.toggleState === ArtifactModes.SHADCNUI && (
          <Check className="size-5" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={handleCustomToggle}
        className="flex w-full items-center justify-between rounded-lg px-2 py-3 text-base hover:bg-surface-hover"
      >
        <span>Mode prompt personnalisé</span>
        {artifacts?.toggleState === ArtifactModes.CUSTOM && (
          <Check className="size-5" aria-hidden="true" />
        )}
      </button>
    </div>
  );

  /** Panneau Connecteurs : liste, ajout, et configuration. */
  const mcpConfigDialogProps = mcpServerManager?.getConfigDialogProps?.();
  const mcpPanel = mcpServerManager ? (
    <div className="relative flex flex-col gap-1">
      {isConnectorsMenuOpen && (
        <div className="absolute right-0 top-0 z-10 flex w-72 flex-col rounded-xl border border-border-light bg-surface-secondary p-1 shadow-lg">
          <button
            type="button"
            onClick={() => setIsConnectorsMenuOpen(false)}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover"
          >
            Parcourir les connecteurs
          </button>
          <button
            type="button"
            onClick={() => {
              setIsConnectorsMenuOpen(false);
              setIsAddCustomOpen(true);
            }}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover"
          >
            Ajouter un connecteur personnalisé
          </button>
        </div>
      )}

      {selectableServers.map((server) => {
        const checked = mcpServerManager.mcpValues?.includes(server.serverName) ?? false;
        return (
          <button
            key={server.serverName}
            type="button"
            onClick={() => mcpServerManager.toggleServerSelection(server.serverName)}
            className="flex w-full items-center gap-3 rounded-lg text-left hover:bg-surface-hover"
          >
            <ToolRow
              Icon={MCPIcon}
              label={server.serverName}
              right={<ToggleSwitch checked={checked} />}
            />
          </button>
        );
      })}

      {mcpConfigDialogProps && (
        <MCPConfigDialog {...mcpConfigDialogProps} storageContextKey={storageContextKey} />
      )}
      <AddCustomMCPServerDialog isOpen={isAddCustomOpen} onOpenChange={setIsAddCustomOpen} />
    </div>
  ) : null;

  const menuTrigger = (
    <TooltipAnchor
      render={
        <button
          type="button"
          disabled={isDisabled}
          id="tools-dropdown-button"
          aria-label="Ajouter à la conversation"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((open) => !open)}
          className={cn(
            'flex size-theme-control items-center justify-center rounded-theme-control-round p-1 transition-colors duration-theme-fast hover:bg-surface-composer-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-opacity-50',
            isOpen && 'bg-surface-composer-hover',
          )}
        >
          <Plus className="size-5" aria-hidden="true" />
        </button>
      }
      id="tools-dropdown-button"
      description={localize('com_ui_tools')}
      disabled={isDisabled}
    />
  );

  const title =
    view === 'artifacts' ? 'Artefacts' : view === 'mcp' ? 'Connecteurs' : 'Ajouter à la conversation';

  return (
    <>
      {menuTrigger}
      {isOpen &&
        createPortal(
          <div className="fixed inset-0 z-[100]">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setIsOpen(false)}
              aria-hidden="true"
            />
            <div
              role="dialog"
              aria-label={title}
              data-testid="tools-sheet"
              className="absolute inset-x-0 bottom-0 flex h-[92dvh] flex-col overflow-hidden rounded-t-3xl bg-surface-primary shadow-2xl"
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            >
              <div className="flex justify-center pb-1 pt-3">
                <span className="h-1 w-10 rounded-full bg-surface-tertiary" aria-hidden="true" />
              </div>

              <div className="flex items-center justify-between px-4 pb-3 pt-2">
                {view === 'root' ? (
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    aria-label="Fermer"
                    className="rounded-full p-2 hover:bg-surface-hover"
                  >
                    <X className="size-5" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setView('root')}
                    aria-label="Retour"
                    className="rounded-full p-2 hover:bg-surface-hover"
                  >
                    <ChevronLeft className="size-5" aria-hidden="true" />
                  </button>
                )}
                <span className="text-base font-semibold text-text-primary">{title}</span>
                {view === 'mcp' ? (
                  <button
                    type="button"
                    onClick={() => setIsConnectorsMenuOpen((open) => !open)}
                    aria-label="Ajouter un connecteur"
                    className="rounded-full p-2 hover:bg-surface-hover"
                  >
                    <Plus className="size-5" aria-hidden="true" />
                  </button>
                ) : (
                  <span className="size-9" aria-hidden="true" />
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-4 pb-6">
                {view === 'root' && (
                  <>
                    <div data-testid="tools-menu-attach" className="grid grid-cols-3 gap-2 pb-4">
                      {attachTiles.map(({ id, label, Icon }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => {
                            setIsOpen(false);
                            openExistingAttachMenu();
                          }}
                          className="flex flex-col items-center gap-3 rounded-2xl bg-surface-secondary px-2 py-5 text-text-primary hover:bg-surface-hover"
                        >
                          <span className="flex size-12 items-center justify-center rounded-full bg-surface-tertiary">
                            <Icon className="size-5" aria-hidden="true" />
                          </span>
                          <span className="text-sm">{label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1 rounded-2xl bg-surface-secondary px-3 py-1">
                      {rootRows.map((row, i) => (
                        <div key={i} className={cn(i > 0 && 'border-t border-border-light')}>
                          {row}
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {view === 'artifacts' && artifactsPanel}
                {view === 'mcp' && mcpPanel}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
};

export default React.memo(ToolsDropdown);
