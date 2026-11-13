# Ministre (proxy MCP intégré à LibreChat)

Lancé automatiquement avec LibreChat par `patch-ministre.js` (même conteneur Fly, port local 3090, non exposé sur Internet).
L'agent ne voit que 3 outils : `chercher_outil`, `appeler_outil`, `verifier`.

## Activation (une fois)

```bash
fly secrets set MINISTRE_SECRET=<un-secret-long> GITHUB_TOKEN=<jeton-lecture-actions>
fly secrets set UPSTREAMS='{"github":{"url":"https://...","headers":{"Authorization":"Bearer ..."},"about":"depots, fichiers, issues"}}'
```

Puis, dans `librechat.yaml` :

```yaml
mcpServers:
  ministre:
    type: streamable-http
    url: http://127.0.0.1:3090
    headers:
      Authorization: "Bearer ${MINISTRE_SECRET}"
    timeout: 60000
```

et dans `modelSpecs`, remplacer `mcpServers` par `["ministre"]`.

## Variables optionnelles

`MAX_CHARS` (4000), `MAX_ITEMS` (15), `MAX_STR` (600), `CATALOG_TTL` (600 s), `MINISTRE_PORT` (3090).

## Limites v0.1

- Serveurs derrière le Ministre : en-têtes fixes (jetons). L'OAuth par utilisateur n'est pas encore géré.
- Sans état : une session MCP est ouverte à chaque appel (catalogue en cache 10 min).
- Recherche par mots-clés.
