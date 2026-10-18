import React, { useState, useMemo, useCallback, useEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { TooltipAnchor, DropdownPopup, PinIcon, VectorIcon, MCPIcon } from '@librechat/client';
import {
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
  TerminalSquareIcon,
  WandSparkles,
} from 'lucide-react';
import {
  AuthType,
  Permissions,
  ArtifactModes,
  PermissionTypes,
  defaultAgentCapabilities,
} from 'librechat-data-provider';
import type { MenuItemProps } from '~/common';
import {
  useLocalize,
  useHasAccess,
  useAuthContext,
  useHasMemoryAccess,
  useAgentCapabilities,
} from '~/hooks';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import MCPServerMenuItem from '~/components/MCP/MCPServerMenuItem';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import AddCustomMCPServerDialog from '~/components/MCP/AddCustomMCPServerDialog';
import { useGetStartupConfig } from '~/data-provider';
import { useBadgeRowContext } from '~/Providers';
import { cn } from '~/utils';

interface ToolsDropdownProps {
  disabled?: boolean;
}

type MenuView = 'root' | 'artifacts' | 'mcp';

/** Ariakit portals to document.body by default, which puts the menu outside every landmark.
 *  Returning null falls back to that default. */
const getMainLandmark = () => document.querySelector<HTMLElement>('main');

/** Ouvre le menu d'envoi de fichiers existant (trombone), sans le dupliquer. */
const openExistingAttachMenu = () => {
  const trigger =
    document.getElementById('attach-file-menu-button') ??
    document.getElementById('attach-file-button');
  trigger?.click();
};

const ToolsDropdown = ({ disabled }: ToolsDropdownProps) => {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const context = useBadgeRowContext();
  const { data: startupConfig } = useGetStartupConfig();

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

  const [isPopoverActive, setIsPopoverActive] = useState(false);
  const [view, setView] = useState<MenuView>('root');
  const [isAddCustomOpen, setIsAddCustomOpen] = useState(false);
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
  const {
    isPinned: isSearchPinned,
    setIsPinned: setIsSearchPinned,
    authData: webSearchAuthData,
  } = webSearch ?? {};
  const { isPinned: isCodePinned, setIsPinned: setIsCodePinned } = codeInterpreter ?? {};
  const { isPinned: isFileSearchPinned, setIsPinned: setIsFileSearchPinned } = fileSearch ?? {};
  const { isPinned: isArtifactsPinned, setIsPinned: setIsArtifactsPinned } = artifacts ?? {};
  const { isPinned: isSkillsPinned, setIsPinned: setIsSkillsPinned } = skills ?? {};
  const { isPinned: isMemoryPinned, setIsPinned: setIsMemoryPinned } = memory ?? {};

  const selectableServers = mcpServerManager?.selectableServers ?? [];

  /** Rafraîchit la liste des serveurs MCP tant que le panneau est ouvert. */
  useMCPRefresh({
    enabled: isPopoverActive && view === 'mcp' && selectableServers.length > 0,
  });

  /** Quand le menu se ferme, on revient toujours à la liste principale. */
  useEffect(() => {
    if (!isPopoverActive) {
      setView('root');
    }
  }, [isPopoverActive]);

  const showWebSearchSettings = useMemo(() => {
    const authTypes = webSearchAuthData?.authTypes ?? [];
    if (authTypes.length === 0) return true;
    return !authTypes.every(([, authType]) => authType === AuthType.SYSTEM_DEFINED);
  }, [webSearchAuthData?.authTypes]);

  const handleWebSearchToggle = useCallback(() => {
    const newValue = !webSearch?.toggleState;
    webSearch?.debouncedChange({ value: newValue });
  }, [webSearch]);

  const handleCodeInterpreterToggle = useCallback(() => {
    const newValue = !codeInterpreter?.toggleState;
    codeInterpreter?.debouncedChange({ value: newValue });
  }, [codeInterpreter]);

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

  const mcpPlaceholder = startupConfig?.interface?.mcpServers?.placeholder;

  /** Trois raccourcis en haut du menu, comme dans l'application Claude. */
  const attachTiles = [
    { id: 'camera', label: 'Appareil photo', Icon: Camera },
    { id: 'photos', label: 'Photos', Icon: ImageIcon },
    { id: 'files', label: 'Fichiers', Icon: FileUp },
  ];

  const rootItems: MenuItemProps[] = [];

  rootItems.push({
    hideOnClick: false,
    render: (props) => (
      <div {...props} data-testid="tools-menu-attach" className="grid grid-cols-3 gap-2 p-1">
        {attachTiles.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsPopoverActive(false);
              openExistingAttachMenu();
            }}
            className="flex flex-col items-center gap-2 rounded-xl bg-surface-secondary p-3 text-text-primary hover:bg-surface-hover"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-surface-tertiary">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <span className="text-xs">{label}</span>
          </button>
        ))}
      </div>
    ),
  });

  if (fileSearchEnabled && canUseFileSearch) {
    rootItems.push({
      onClick: handleFileSearchToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props} data-testid="tools-menu-file-search">
          <div className="flex items-center gap-2">
            <VectorIcon className="icon-md" />
            <span>{localize('com_assistants_file_search')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsFileSearchPinned?.(!isFileSearchPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isFileSearchPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isFileSearchPinned ? 'Unpin' : 'Pin'}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isFileSearchPinned} />
            </div>
          </button>
        </div>
      ),
    });
  }

  if (canUseWebSearch && webSearchEnabled) {
    rootItems.push({
      onClick: handleWebSearchToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props}>
          <div className="flex items-center gap-2">
            <Globe className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_web_search')}</span>
          </div>
          <div className="flex items-center gap-1">
            {showWebSearchSettings && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSearchDialogOpen?.(true);
                }}
                className={cn(
                  'rounded p-1 transition-all duration-200',
                  'hover:bg-surface-secondary hover:shadow-sm',
                  'text-text-secondary hover:text-text-primary',
                )}
                aria-label="Configure web search"
                ref={searchMenuTriggerRef}
              >
                <div className="h-4 w-4">
                  <Settings className="h-4 w-4" aria-hidden="true" />
                </div>
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsSearchPinned?.(!isSearchPinned);
              }}
              className={cn(
                'rounded p-1 transition-all duration-200',
                'hover:bg-surface-secondary hover:shadow-sm',
                !isSearchPinned && 'text-text-secondary hover:text-text-primary',
              )}
              aria-label={isSearchPinned ? 'Unpin' : 'Pin'}
            >
              <div className="h-4 w-4">
                <PinIcon unpin={isSearchPinned} />
              </div>
            </button>
          </div>
        </div>
      ),
    });
  }

  if (canUseSkills && skillsEnabled) {
    rootItems.push({
      onClick: handleSkillsToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props} data-testid="tools-menu-skills">
          <div className="flex items-center gap-2">
            <ScrollText className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_skills')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsSkillsPinned?.(!isSkillsPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isSkillsPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isSkillsPinned ? localize('com_ui_unpin') : localize('com_ui_pin')}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isSkillsPinned} />
            </div>
          </button>
        </div>
      ),
    });
  }

  if (showMemory) {
    rootItems.push({
      onClick: handleMemoryToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props} data-testid="tools-menu-memory">
          <div className="flex items-center gap-2">
            <Brain className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_memory')}</span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsMemoryPinned?.(!isMemoryPinned);
            }}
            className={cn(
              'rounded p-1 transition-all duration-200',
              'hover:bg-surface-secondary hover:shadow-sm',
              !isMemoryPinned && 'text-text-secondary hover:text-text-primary',
            )}
            aria-label={isMemoryPinned ? localize('com_ui_unpin') : localize('com_ui_pin')}
          >
            <div className="h-4 w-4">
              <PinIcon unpin={isMemoryPinned} />
            </div>
          </button>
        </div>
      ),
    });
  }

  if (canRunCode && codeEnabled) {
    rootItems.push({
      onClick: handleCodeInterpreterToggle,
      hideOnClick: false,
      render: (props) => (
        <div {...props} data-testid="tools-menu-run-code">
          <div className="flex items-center gap-2">
            <TerminalSquareIcon className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_run_code')}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsCodePinned?.(!isCodePinned);
              }}
              className={cn(
                'rounded p-1 transition-all duration-200',
                'hover:bg-surface-secondary hover:shadow-sm',
                !isCodePinned && 'text-text-primary hover:text-text-primary',
              )}
              aria-label={isCodePinned ? 'Unpin' : 'Pin'}
            >
              <div className="h-4 w-4">
                <PinIcon unpin={isCodePinned} />
              </div>
            </button>
          </div>
        </div>
      ),
    });
  }

  /** Artefacts et Serveurs MCP : une ligne qui ouvre le panneau dans le même menu. */
  if (artifactsEnabled && setIsArtifactsPinned != null) {
    rootItems.push({
      hideOnClick: false,
      render: (props) => (
        <div
          {...props}
          data-testid="tools-menu-artifacts"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setView('artifacts');
          }}
          className="cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <WandSparkles className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_artifacts')}</span>
          </div>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </div>
      ),
    });
  }

  if (canUseMcp && mcpServerManager) {
    rootItems.push({
      hideOnClick: false,
      render: (props) => (
        <div
          {...props}
          data-testid="tools-menu-mcp"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setView('mcp');
          }}
          className="cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <MCPIcon className="icon-md" aria-hidden="true" />
            <span>{localize('com_ui_mcp_servers')}</span>
          </div>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </div>
      ),
    });
  }

  /** Panneau Artefacts : remplace la liste, avec une flèche retour. */
  const artifactsPanel = (
    <div className="w-72">
      <div className="flex items-center gap-2 px-1 pb-2">
        <button
          type="button"
          onClick={() => setView('root')}
          aria-label="Retour"
          className="rounded p-1 hover:bg-surface-hover"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <span className="font-medium">{localize('com_ui_artifacts')}</span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleShadcnToggle();
        }}
        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-surface-hover"
      >
        <span>{localize('com_ui_include_shadcnui' as never)}</span>
        {artifacts?.toggleState === ArtifactModes.SHADCNUI && (
          <Check className="size-4" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleCustomToggle();
        }}
        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-surface-hover"
      >
        <span>{localize('com_ui_custom_prompt_mode' as never)}</span>
        {artifacts?.toggleState === ArtifactModes.CUSTOM && (
          <Check className="size-4" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handleArtifactsToggle();
        }}
        className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-surface-hover"
      >
        <span>{localize('com_ui_artifacts')}</span>
        {!!artifacts?.toggleState && <Check className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );

  /** Panneau Serveurs MCP : liste des serveurs, ajout, et configuration. */
  const mcpConfigDialogProps = mcpServerManager?.getConfigDialogProps?.();
  const mcpPanel = mcpServerManager ? (
    <div className="w-72">
      <div className="flex items-center gap-2 px-1 pb-2">
        <button
          type="button"
          onClick={() => setView('root')}
          aria-label="Retour"
          className="rounded p-1 hover:bg-surface-hover"
        >
          <ChevronLeft className="size-5" aria-hidden="true" />
        </button>
        <span className="font-medium">{localize('com_ui_mcp_servers')}</span>
      </div>
      <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
        {selectableServers.map((server) => (
          <MCPServerMenuItem
            key={server.serverName}
            server={server}
            isSelected={mcpServerManager.mcpValues?.includes(server.serverName) ?? false}
            connectionStatus={mcpServerManager.connectionStatus}
            isInitializing={mcpServerManager.isInitializing}
            statusIconProps={mcpServerManager.getServerStatusIconProps(server.serverName)}
            onToggle={mcpServerManager.toggleServerSelection}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setIsAddCustomOpen(true);
        }}
        className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      >
        <Plus className="size-4" aria-hidden="true" />
        <span>{localize('com_ui_add_custom_mcp_server' as never)}</span>
      </button>
      {mcpConfigDialogProps && (
        <MCPConfigDialog {...mcpConfigDialogProps} storageContextKey={storageContextKey} />
      )}
      <AddCustomMCPServerDialog isOpen={isAddCustomOpen} onOpenChange={setIsAddCustomOpen} />
    </div>
  ) : null;

  /** Dans un panneau, le menu n'affiche que ce panneau. */
  const dropdownItems: MenuItemProps[] =
    view === 'root'
      ? rootItems
      : [
          {
            hideOnClick: false,
            render: (props) => (
              <div {...props}>{view === 'artifacts' ? artifactsPanel : mcpPanel}</div>
            ),
          },
        ];

  if (dropdownItems.length === 0) {
    return null;
  }

  const menuTrigger = (
    <TooltipAnchor
      render={
        <Ariakit.MenuButton
          disabled={isDisabled}
          id="tools-dropdown-button"
          aria-label="Ajouter à la conversation"
          className={cn(
            'flex size-theme-control items-center justify-center rounded-theme-control-round p-1 transition-colors duration-theme-fast hover:bg-surface-composer-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-opacity-50',
            isPopoverActive && 'bg-surface-composer-hover',
          )}
        >
          <div className="flex w-full items-center justify-center gap-2">
            <Plus className="size-5" aria-hidden="true" />
          </div>
        </Ariakit.MenuButton>
      }
      id="tools-dropdown-button"
      description={localize('com_ui_tools')}
      disabled={isDisabled}
    />
  );

  return (
    <DropdownPopup
      itemClassName="flex w-full cursor-pointer rounded-lg items-center justify-between hover:bg-surface-hover gap-5"
      menuId="tools-dropdown-menu"
      isOpen={isPopoverActive}
      setIsOpen={setIsPopoverActive}
      modal={false}
      portal={true}
      portalElement={getMainLandmark}
      preserveTabOrder={false}
      unmountOnHide={true}
      trigger={menuTrigger}
      items={dropdownItems}
      iconClassName="mr-0"
    />
  );
};

export default React.memo(ToolsDropdown);
