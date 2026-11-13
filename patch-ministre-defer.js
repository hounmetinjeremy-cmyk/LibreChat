/**
 * Le Ministre, version intégrée à LibreChat : l'agent ne voit AUCUN outil MCP au départ.
 *
 * Principe : LibreChat sait déjà « différer » des outils. Un outil différé n'est pas envoyé au modèle ;
 * le modèle le trouve à la demande avec l'outil de recherche intégré (tool_search), puis l'appelle.
 * Aujourd'hui il faut le régler outil par outil dans l'agent. Ce patch ajoute un réglage GLOBAL :
 * il s'applique donc à TOUS les serveurs MCP, y compris ceux que les utilisateurs ajoutent eux-mêmes
 * (ou toi dans l'interface admin), sans rien déclarer. La connexion de chaque utilisateur
 * (OAuth, jetons, en-têtes) reste gérée par LibreChat, exactement comme avant.
 *
 * Variables (secrets ou variables d'environnement Fly) :
 *   MINISTRE_DEFER_ALL=on                       active le mode. Sans elle, ce patch ne change RIEN.
 *   MINISTRE_DIRECT_SERVERS=sandbox,sandbox-soleil   serveurs dont les outils restent toujours visibles
 *                                                    (le terminal, utilisé à chaque tâche).
 * Un réglage explicite de l'agent (tool_options.defer_loading) l'emporte toujours sur ce défaut.
 *
 * Le patch est idempotent et jamais bloquant : si le code de LibreChat a changé et qu'une ancre
 * n'est pas retrouvée, rien n'est modifié (avertissement dans le journal du build).
 */
const fs = require('fs');

const file = 'packages/api/src/tools/classification.ts';
const MARK = 'MINISTRE_DEFER_ALL';

if (!fs.existsSync(file)) {
  console.warn('patch-ministre-defer : ' + file + ' introuvable, ignoré');
  process.exit(0);
}

const src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log('patch-ministre-defer : déjà appliqué');
  process.exit(0);
}

const edits = [
  {
    name: 'fonction utilitaire',
    from: 'export type { LCTool, LCToolRegistry, AllowedCaller, JsonSchemaType };',
    to: [
      'export type { LCTool, LCToolRegistry, AllowedCaller, JsonSchemaType };',
      '',
      '/**',
      ' * Ministre : avec MINISTRE_DEFER_ALL=on, tous les outils MCP sont différés par défaut (le modèle',
      " * les trouve à la demande). MINISTRE_DIRECT_SERVERS : serveurs dont les outils restent visibles.",
      ' */',
      'const ministreDeferDefault = (serverName?: string): boolean => {',
      "  if (process.env.MINISTRE_DEFER_ALL !== 'on') {",
      '    return false;',
      '  }',
      "  const direct = (process.env.MINISTRE_DIRECT_SERVERS ?? '')",
      "    .split(',')",
      '    .map((name) => name.trim())',
      '    .filter(Boolean);',
      '  return !(serverName != null && direct.includes(serverName));',
      '};',
    ].join('\n'),
  },
  {
    name: 'défaut de defer_loading',
    from: '    const defer_loading = agentOptions?.defer_loading === true;',
    to: '    const defer_loading =\n      (agentOptions?.defer_loading ?? ministreDeferDefault(tool.serverName)) === true;',
  },
  {
    name: 'registre sans options d\'agent',
    from: [
      '  if (agentToolOptions && Object.keys(agentToolOptions).length > 0) {',
      '    return buildToolRegistryFromAgentOptions(mcpToolDefs, agentToolOptions);',
      '  }',
    ].join('\n'),
    to: [
      '  if (',
      "    process.env.MINISTRE_DEFER_ALL === 'on' ||",
      '    (agentToolOptions && Object.keys(agentToolOptions).length > 0)',
      '  ) {',
      '    return buildToolRegistryFromAgentOptions(mcpToolDefs, agentToolOptions ?? {});',
      '  }',
    ].join('\n'),
  },
  {
    name: 'paramètre deferredToolsEnabled',
    from: '    deferredToolsEnabled = true,\n',
    to: '    deferredToolsEnabled: deferredToolsEnabledParam = true,\n',
  },
  {
    name: 'capacité deferred_tools',
    from: '  } = params;\n  const isGoogle =',
    to: [
      '  } = params;',
      "  /** Ministre : le mode « tout différé » n'exige pas la capacité deferred_tools de l'agent. */",
      '  const deferredToolsEnabled =',
      "    deferredToolsEnabledParam || process.env.MINISTRE_DEFER_ALL === 'on';",
      '  const isGoogle =',
    ].join('\n'),
  },
];

let out = src;
for (const edit of edits) {
  const count = out.split(edit.from).length - 1;
  if (count !== 1) {
    console.warn(
      'patch-ministre-defer : ancre « ' + edit.name + ' » trouvée ' + count + ' fois (1 attendue), patch ignoré',
    );
    process.exit(0);
  }
  out = out.replace(edit.from, () => edit.to);
}

fs.writeFileSync(file, out);
console.log('patch-ministre-defer : appliqué (' + edits.length + ' modifications)');
