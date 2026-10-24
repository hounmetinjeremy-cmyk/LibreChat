// Patch de build : ajoute l'instruction de dev-agent-prompt.txt à tous les agents
// (le texte est copié dans le code au moment du build). Désactivable avec
// la variable d'environnement DISABLE_DEFAULT_PROMPT=1. Si le point d'insertion est
// introuvable, le patch est ignoré (avertissement) et le build continue.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'api', 'server', 'controllers', 'agents', 'client.js');
const prompt = fs.readFileSync(path.join(__dirname, 'dev-agent-prompt.txt'), 'utf8').trim();
const marker = prompt.split('\n')[0];
const anchor =
  "      agent.additional_instructions = agent.additional_instructions?.trim() || undefined;\n" +
  "      return agent;\n" +
  "    };";

const injection =
  "      agent.additional_instructions = agent.additional_instructions?.trim() || undefined;\n" +
  "      if (process.env.DISABLE_DEFAULT_PROMPT !== '1') {\n" +
  "        const devPrompt = " + JSON.stringify(prompt) + ";\n" +
  "        const devMarker = " + JSON.stringify(marker) + ";\n" +
  "        if (!(agent.instructions || '').includes(devMarker)) {\n" +
  "          agent.instructions = devPrompt + (agent.instructions ? '\\n\\n' + agent.instructions : '');\n" +
  "        }\n" +
  "      }\n" +
  "      return agent;\n" +
  "    };";

const source = fs.readFileSync(file, 'utf8');
if (source.includes('DISABLE_DEFAULT_PROMPT')) {
  console.log('[patch-agent-prompt] déjà appliqué');
} else if (source.split(anchor).length !== 2) {
  console.warn('[patch-agent-prompt] point d\'insertion introuvable, patch ignoré');
} else {
  fs.writeFileSync(file, source.split(anchor).join(injection));
  console.log('[patch-agent-prompt] appliqué');
}
