/**
 * Branche le Ministre INTÉGRÉ (api/server/services/ministre.js) dans api/server/services/ToolService.js.
 * Trois points d'accroche :
 *   1. l'import du module ;
 *   2. à la fin de loadToolDefinitionsWrapper : les définitions d'outils MCP sont remplacées par les
 *      3 définitions du Ministre (chercher_outil, appeler_outil, verifier) ;
 *   3. dans loadToolsForExecution : ces 3 outils sont fournis à l'agent, et appeler_outil exécute
 *      l'outil MCP réel avec les droits et jetons de l'utilisateur (via le gestionnaire MCP de LibreChat).
 *
 * Tout est INACTIF tant que MINISTRE_MODE=on n'est pas défini (secret Fly). En cas d'erreur du Ministre,
 * LibreChat garde son comportement normal.
 * Idempotent, jamais bloquant : si un point d'accroche est introuvable (ou en double), AUCUNE modification
 * n'est faite et un avertissement est affiché (le build continue).
 */
const fs = require('fs');

const file = 'api/server/services/ToolService.js';
const marker = "require('./ministre')";

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (e) {
  console.warn('patch-ministre-core : ToolService.js illisible, ignoré');
  process.exit(0);
}
if (src.includes(marker)) {
  console.log('patch-ministre-core : déjà appliqué');
  process.exit(0);
}
if (!fs.existsSync('api/server/services/ministre.js')) {
  console.warn('patch-ministre-core : api/server/services/ministre.js absent, ignoré');
  process.exit(0);
}

const IMPORT_ANCHOR = "const { logger, redactMessage, getTenantId } = require('@librechat/data-schemas');\n";

const DEFS_ANCHOR = '  return {\n    toolRegistry,\n    mcpAvailableTools,\n    requestScopedConnections,\n';

const EXEC_ANCHOR =
  '  if (regularToolNames.length > 0) {\n' +
  '    const includesWebSearch = regularToolNames.includes(Tools.web_search);\n' +
  '    const webSearchCallbacks = includesWebSearch\n' +
  '      ? createOnSearchResults(res, streamId, jobCreatedAt)\n' +
  '      : undefined;\n';

const DEFS_HOOK = `  /* Ministre (MINISTRE_MODE=on) : 3 outils au lieu de toutes les définitions MCP. */
  if (ministre.isOn()) {
    try {
      ({ toolDefinitions, toolRegistry } = ministre.reduceDefinitions({ toolDefinitions, toolRegistry }));
    } catch (error) {
      logger.warn('[Ministre] définitions non réduites, comportement normal conservé', getSafeErrorMetadata(error));
    }
  }

`;

const EXEC_HOOK = `  /* Ministre (MINISTRE_MODE=on) : fournit chercher_outil / appeler_outil / verifier. */
  if (ministre.isOn() && regularToolNames.some(ministre.isMinistreName)) {
    for (let i = regularToolNames.length - 1; i >= 0; i--) {
      if (ministre.isMinistreName(regularToolNames[i])) {
        regularToolNames.splice(i, 1);
      }
    }
    try {
      const runMinistreTool = async (toolKey, toolArgs) => {
        const { loadedTools: mcpTools } = await loadTools({
          agent,
          signal,
          userMCPAuthMap,
          functions: true,
          tools: [toolKey],
          user: req.user.id,
          options: {
            req,
            res,
            requestBody: runtimeRequestBody,
            agentResourceType,
            jobCreatedAt,
            tool_resources,
            processFileURL,
            uploadImageBuffer,
            returnMetadata: true,
            mcpAvailableTools,
            accessibleMcpServerNames,
            requestScopedConnections: mcpRequestScopedConnections,
            upstreamTokenProvider,
            upstreamTokenProviderResolver,
          },
          webSearch: appConfig?.webSearch,
          fileStrategy: appConfig?.fileStrategy,
          imageOutputType: appConfig?.imageOutputType,
        });
        const mcpTool = mcpTools?.[0];
        if (!mcpTool) {
          throw new Error('outil indisponible ou non autorisé');
        }
        return mcpTool.invoke(toolArgs, { configurable });
      };
      allLoadedTools.push(
        ...ministre.createMinistreTools({
          toolFn,
          mcpAvailableTools,
          agentTools: agent?.tools,
          userId: req.user.id,
          runTool: runMinistreTool,
          logger,
        }),
      );
    } catch (error) {
      logger.error('[Ministre] création des outils impossible', getSafeErrorMetadata(error));
    }
  }

`;

const count = (text, needle) => text.split(needle).length - 1;
const anchors = [
  ['import', IMPORT_ANCHOR],
  ['définitions', DEFS_ANCHOR],
  ['exécution', EXEC_ANCHOR],
];
for (const [name, anchor] of anchors) {
  const n = count(src, anchor);
  if (n !== 1) {
    console.warn(`patch-ministre-core : accroche « ${name} » trouvée ${n} fois (attendu : 1), patch ignoré`);
    process.exit(0);
  }
}

src = src.replace(IMPORT_ANCHOR, () => `${IMPORT_ANCHOR}const ministre = require('./ministre');\n`);
src = src.replace(DEFS_ANCHOR, () => `${DEFS_HOOK}${DEFS_ANCHOR}`);
src = src.replace(EXEC_ANCHOR, () => `${EXEC_HOOK}${EXEC_ANCHOR}`);

fs.writeFileSync(file, src);
console.log('patch-ministre-core : appliqué');
