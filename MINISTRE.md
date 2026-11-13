# Le Ministre intégré à LibreChat

L'agent ne voit que **3 outils** au lieu de toutes les fonctions de tous les serveurs MCP :

| Outil | Rôle |
| --- | --- |
| `chercher_outil` | trouve les meilleurs outils (nom exact + paramètres) pour une demande |
| `appeler_outil` | exécute l'un d'eux avec les droits et jetons **de l'utilisateur**, puis renvoie un résultat nettoyé et court |
| `verifier` | état de la CI GitHub Actions d'un dépôt (jeton personnel de l'utilisateur) |

Comme il est **dans** LibreChat (entre le gestionnaire MCP et l'agent), il couvre **tous** les serveurs MCP de l'agent,
y compris ceux ajoutés par les utilisateurs (`mcpServers.create: true`). Aucune authentification à refaire :
OAuth, jetons personnels et en-têtes restent gérés par LibreChat.

## Fichiers

- `api/server/services/ministre.js` : le module (catalogue, recherche, nettoyage, les 3 outils).
- `patch-ministre-core.js` : 3 points d'accroche dans `ToolService.js` (lancé par le Dockerfile comme les autres patchs).

## Activer / couper

```bash
fly secrets set MINISTRE_MODE=on     # activer
fly secrets unset MINISTRE_MODE      # couper aussitôt : retour au comportement normal de LibreChat
```

Sans `MINISTRE_MODE=on`, rien ne change. Réglages optionnels : `MAX_CHARS` (4000), `MAX_ITEMS` (15), `MAX_STR` (600), `MINISTRE_TOP` (5).

## Sécurité

- `appeler_outil` n'accepte que les outils des serveurs **sélectionnés pour l'agent** (serveur épinglé ou outil coché) ; tout autre nom est refusé sans être exécuté.
- L'exécution passe par le chargeur d'outils de LibreChat avec l'identité de l'utilisateur de la requête.
- Si le patch ne trouve pas ses points d'accroche (mise à jour de LibreChat), il n'applique rien et le build continue.

## À savoir

- Non testé dans une vraie instance de LibreChat au moment de l'écriture : premier test = chez toi, avec `MINISTRE_MODE=on`.
- Ce Ministre remplace le Ministre séparé de la PR n°16 (`ministre/`), qui ne couvre pas les serveurs ajoutés par les utilisateurs.
