'use strict';
/**
 * RÉGLAGES D'ÉCONOMIE DE TOKENS : tout est ici, dans le code. Aucun secret Fly à ajouter ni à modifier.
 * Ce fichier est chargé en tout premier au démarrage du serveur (patch-tuning.js) et GAGNE sur les variables
 * d'environnement de Fly (anciens secrets compris) : pour changer un réglage, on modifie la valeur ci-dessous.
 * Exception d'urgence : TUNING_ENV_WINS=on (variable Fly) laisse les variables d'environnement l'emporter.
 * Les vraies clés (OpenRouter, GitHub, Google...) restent des secrets Fly : elles ne doivent jamais être dans le code.
 */
const TUNING = {
  // --- Outils MCP : chargés à la demande, sauf le terminal qui reste visible dès le départ ---
  MINISTRE_DEFER_ALL: 'on',
  MINISTRE_DIRECT_SERVERS: 'sandbox,sandbox-soleil',
  // Schémas d'outils réduits au squelette (noms, types, champs obligatoires).
  TOOL_SLIM_MODE: 'skeleton',

  // --- Résultats d'outils renvoyés à l'IA ---
  MCP_RESULT_JSON_MAX_CHARS: '600',
  MCP_RESULT_CONTENT_MAX_CHARS: '2500',
  MCP_RESULT_DROP_KEYS:
    'icon,icons,iconUrl,avatar,avatarUrl,thumbnail,thumbnailUrl,logo,logoUrl,favicon,nodeId,gravatarId',

  // --- Historique : toute la conversation résumée en 4 lignes ; vieux résultats d'outils purgés ---
  HISTORY_SUMMARY_LINES: '4',
  HISTORY_KEEP_TOOL_RESULTS: '4',
  HISTORY_TRIM_STEP: '4',

  // --- Réponses et étapes ---
  CHAT_MAX_OUTPUT: '6000',
  MAX_TOOL_STEPS_ADMIN: '40',

  // --- Moteur : Particle AI (gratuit, puis payant, puis la chaîne habituelle) pour Aube ---
  PARTICLE_AI: 'on',
  PARTICLE_ROLES: 'aube',

  // --- Expert d'appoint (modèle payant) : désactivé. Mettre 'on' pour l'activer. ---
  EXPERT_HELP: 'off',
};

if (process.env.TUNING_ENV_WINS !== 'on') {
  for (const [name, value] of Object.entries(TUNING)) {
    process.env[name] = value;
  }
}

module.exports = TUNING;
