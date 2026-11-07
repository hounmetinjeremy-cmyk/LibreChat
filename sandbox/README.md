# Terminal jetable (sandbox) — moteur unique

L'IA du chat est le SEUL moteur : elle pilote le terminal avec l'outil MCP `execute_command`.
Le conteneur Fly est un exécuteur passif (aucune clé LLM, aucune IA autonome).

- `orchestrator/` : serveur MCP (find_repos, execute_command, close_session, my_quota, link_pages). Crée un conteneur à la première commande, le garde ouvert entre les appels (10 min d'inactivité max, 1 h au total).
- `worker/run.js` : boucle qui attend les commandes de l'orchestrateur (`/internal/next`), les lance dans un groupe de processus et renvoie la sortie.

## Arrêt (bouton Stop du chat)

L'appel `execute_command` est lié à un seul signal d'annulation : annulation MCP du chat ou connexion HTTP coupée.
Au déclenchement, l'orchestrateur répond tout de suite au worker (`/internal/watch`) qui envoie SIGTERM puis SIGKILL (2 s) au groupe de processus. Si le worker ne confirme pas en 8 s, le conteneur est détruit.
Endpoint de secours : `POST /sessions/cancel` (Authorization Bearer + X-User-Id).

## Variables (orchestrateur)

FLY_API_TOKEN, SANDBOX_APP, SANDBOX_IMAGE, ORCHESTRATOR_SECRET, ORCHESTRATOR_PUBLIC_URL. Facultatives : SESSION_IDLE_SEC (600), SESSION_MAX_SEC (3600), CMD_MAX_SEC (170, doit rester sous le timeout MCP de librechat.yaml), DAILY_JOBS_PER_USER (5), MAX_CONCURRENT_PER_USER (1), MAX_CONCURRENT_GLOBAL (4). LLM_API_KEY et les variables EXPERT_* ne servent plus.

Les anciens `patch-*.js` et `cf-*.snippet` de `orchestrator/src` ne sont plus utilisés (leur logique est intégrée à `server.js`).
