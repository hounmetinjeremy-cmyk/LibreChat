# Sandboxes éphémères sur Fly.io

LibreChat ne fait que **commander** : il parle à l'orchestrateur (serveur MCP). Rien de lourd ne tourne dans l'app principale.

```
LibreChat ──MCP (X-User-Id posé par LibreChat)──> orchestrateur ──API Machines──> conteneur éphémère
                                                       ^                              │ clone, correction IA, push, PR
                                                       └── proxy LLM + rapport ───────┘ (auto_destroy)
```

- **Orchestrateur** (`orchestrator/`) : seul à détenir `FLY_API_TOKEN` et la clé LLM. Applique les quotas, crée les machines avec `auto_destroy: true`, `restart: no`, aucun port exposé.
- **Worker** (`worker/`) : image du conteneur. Clone, boucle d'agent, push sur la branche `ai-fix/<id>`, ouvre une pull request, puis le processus s'arrête et la machine disparaît.
- **Cloisonnement par utilisateur** : l'identité vient de `{{LIBRECHAT_USER_ID}}` (injecté par le serveur LibreChat, non falsifiable par le modèle). Limites : 1 tâche simultanée, 5 tâches/jour, 150 000 tokens/tâche, 400 000 tokens/jour (voir `orchestrator/fly.toml`).
- **Budget** : le conteneur n'a jamais la clé LLM. Il passe par `/internal/llm`, qui décompte chaque appel et refuse au-delà du plafond.
- **Filet de sécurité** : durée max 900 s (côté worker et côté orchestrateur), balayage toutes les 30 s des machines expirées ou orphelines.

## Déploiement

```bash
# 1. App des conteneurs + image
fly apps create jeremy-sbx-jobs
(cd sandbox/worker && fly deploy --build-only --push --image-label latest -a jeremy-sbx-jobs)
fly tokens create deploy -a jeremy-sbx-jobs        # => FLY_API_TOKEN

# 2. Orchestrateur
fly apps create jeremy-sbx-orch
fly volumes create orch_data -a jeremy-sbx-orch -r ams -n 1 -s 1
fly secrets set -a jeremy-sbx-orch \
  FLY_API_TOKEN=... \
  ORCHESTRATOR_SECRET=$(openssl rand -hex 32) \
  LLM_API_KEY=<clé Gemini>
(cd sandbox/orchestrator && fly deploy -a jeremy-sbx-orch)

# 3. LibreChat : même secret que l'orchestrateur, puis redéploiement
fly secrets set -a librechat-a7cwuq ORCHESTRATOR_SECRET=<le même>
fly deploy -a librechat-a7cwuq
```

Chaque utilisateur saisit son token GitHub (fine-grained, limité à ses dépôts : *Contents* et *Pull requests* en lecture/écriture) dans les réglages du serveur MCP « sandbox ».

## Limites connues

- Les commandes lancées par l'agent (tests) s'exécutent avec un environnement vide, mais le token GitHub reste en mémoire du worker : utiliser des tokens limités à un seul dépôt.
- Une seule machine d'orchestrateur (SQLite sur volume). Pour plusieurs instances, passer à Postgres ou Redis.
- Si la réponse d'un job n'arrive pas avant `recursionLimit: 2` dans `librechat.yaml`, demander le statut dans un second message (`get_job`).
