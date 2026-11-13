# Ministre (proxy MCP intégré à LibreChat)

Lancé automatiquement avec LibreChat par `patch-ministre.js` (même conteneur Fly, port local 3090, non exposé sur Internet).
L'agent ne voit que 3 outils : `chercher_outil`, `appeler_outil`, `verifier`.

## Connexion PAR UTILISATEUR (v0.2)

Chaque appel est fait avec le jeton **personnel** de l'utilisateur, jamais un jeton partagé :

1. LibreChat envoie l'identifiant de l'utilisateur dans l'en-tête `X-User-Id` (posé côté serveur).
2. Pour un serveur en mode `vault`, le Ministre lit le jeton de CET utilisateur dans le coffre de LibreChat
   (ex. `/api/github-link/token`, avec `ORCHESTRATOR_SECRET`, comme le terminal).
3. Si l'utilisateur n'est pas connecté, l'agent reçoit un **lien de connexion signé** (15 min) à lui montrer.
4. L'agent ne voit jamais le jeton : seul le Ministre l'ajoute à l'appel.

## Activation (une fois)

```bash
fly secrets set MINISTRE_SECRET=<un-secret-long>
fly secrets set UPSTREAMS='{"github":{"url":"https://...","about":"depots, fichiers, issues","auth":{"type":"vault","tokenPath":"/api/github-link/token","startPath":"/api/github-link/start"}}}'
```

`ORCHESTRATOR_SECRET` et `DOMAIN_SERVER` existent déjà sur ton app Fly. `GITHUB_TOKEN` n'est plus nécessaire si le serveur `github` est en mode `vault` (`verifier` utilise alors le jeton de l'utilisateur).

Serveur à jeton fixe : `{"url":"...","headers":{"Authorization":"Bearer ..."},"about":"..."}`.

Puis, dans `librechat.yaml` (l'en-tête `X-User-Id` est **indispensable**) :

```yaml
mcpServers:
  ministre:
    type: streamable-http
    url: http://127.0.0.1:3090
    headers:
      Authorization: "Bearer ${MINISTRE_SECRET}"
      X-User-Id: "{{LIBRECHAT_USER_ID}}"
    timeout: 60000
```

et dans `modelSpecs`, remplacer `mcpServers` par `["ministre"]`.

## Variables optionnelles

`MAX_CHARS` (4000), `MAX_ITEMS` (15), `MAX_STR` (600), `CATALOG_TTL` (600 s), `MINISTRE_PORT` (3090).

## Limites

- Mode `vault` prêt pour GitHub (coffre `githubLink`). Les autres fournisseurs (Cloudflare, Google Drive, Supabase, Vercel) demandent chacun un coffre du même type : à ajouter un par un.
- Sans état : une session MCP est ouverte à chaque appel (catalogue en cache 10 min, partagé entre utilisateurs : il ne contient que des noms d'outils).
- Recherche par mots-clés.
