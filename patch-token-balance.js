/**
 * Ajoute l'entrée « Tokens » dans le menu + du champ de saisie (ToolsDropdown) : un écran avec
 * le solde de tokens du jour et une barre horizontale (client/.../TokenBalancePanel.tsx).
 * Jamais bloquant : si une ancre est introuvable, le patch est ignoré avec un avertissement
 * et le build continue.
 */
const fs = require('fs');

const file = 'client/src/components/Chat/Input/ToolsDropdown.tsx';

const tokensRow = [
  '  rootRows.push(',
  '    <button',
  '      key="tokens"',
  '      type="button"',
  '      data-testid="tools-menu-tokens"',
  "      onClick={() => setView('tokens')}",
  '      className="flex w-full items-center gap-3 text-left"',
  '    >',
  '      <ToolRow',
  '        Icon={Coins}',
  '        label="Tokens"',
  '        right={<ChevronRight className="size-5 text-text-secondary" aria-hidden="true" />}',
  '      />',
  '    </button>,',
  '  );',
  '',
  '',
].join('\n');

function apply() {
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('TokenBalancePanel')) {
    console.log('patch-token-balance : déjà appliqué');
    return;
  }

  const rootAnchor = '  if (showMcp) {\n    rootRows.push(';
  const steps = [
    ["type MenuView = 'root' | 'artifacts' | 'mcp';", "type MenuView = 'root' | 'artifacts' | 'mcp' | 'tokens';"],
    ["import { cn } from '~/utils';", "import { cn } from '~/utils';\nimport TokenBalancePanel from './TokenBalancePanel';"],
    ['  Blocks,\n', '  Blocks,\n  Coins,\n'],
    [rootAnchor, tokensRow + rootAnchor],
    [
      "view === 'artifacts' ? 'Artefacts'",
      "view === 'tokens' ? 'Tokens' : view === 'artifacts' ? 'Artefacts'",
    ],
    [
      "{view === 'mcp' && mcpPanel}",
      "{view === 'mcp' && mcpPanel}\n                {view === 'tokens' && <TokenBalancePanel />}",
    ],
  ];

  for (const [from] of steps) {
    if (!src.includes(from)) {
      console.warn('patch-token-balance : ancre introuvable, patch ignoré : ' + from.slice(0, 50));
      return;
    }
  }
  for (const [from, to] of steps) {
    src = src.replace(from, () => to);
  }
  fs.writeFileSync(file, src);
  console.log('patch-token-balance : appliqué');
}

try {
  apply();
} catch (err) {
  console.warn('patch-token-balance : ignoré (' + (err && err.message) + ')');
}
