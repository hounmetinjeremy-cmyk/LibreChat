# Déploiement sur Google Compute Engine

Machine conseillée : Ubuntu 22.04 ou 24.04, 2 Go de mémoire minimum, port 80 ouvert (règle de pare-feu HTTP).

## 1. Installer (coller dans le terminal SSH de la VM)

```
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
git clone https://github.com/hounmetinjeremy-cmyk/LibreChat
cd LibreChat/deploy/gce
cp .env.example .env
```

## 2. Générer les clés

```
echo "CREDS_KEY=$(openssl rand -hex 32)"
echo "CREDS_IV=$(openssl rand -hex 16)"
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
echo "MCP_SECRET=$(openssl rand -hex 24)"
```

Copie ces lignes dans `.env` (commande : `nano .env`), puis remplis aussi :
- `DOMAIN_CLIENT` et `DOMAIN_SERVER` avec l'adresse de la VM
- `GITHUB_TOKEN` : un token GitHub avec le droit d'écrire dans tes dépôts (contenu et pull requests)
- `DEEPSEEK_API_KEY` : ta clé DeepSeek

## 3. Lancer

```
sudo docker compose up -d --build
```

## 4. Brancher l'outil dans LibreChat

Dans LibreChat : ajouter un serveur MCP (menu des outils).
- Type : streamable-http
- URL : `http://dev-fix:3000/mcp`
- En-tête : `Authorization` = `Bearer ` suivi de la valeur de `MCP_SECRET`

## 5. Utiliser

Écrire dans le chat, par exemple : « Dans le dépôt Chap-money, j'ai un problème de paiement : ... ».
L'outil `dev_fix` cherche les fichiers, fait une seule requête au modèle, applique la correction sur une branche et ouvre une pull request. Rien ne touche la branche principale tant que tu n'as pas validé la pull request.

## Mise à jour

```
cd LibreChat && git pull && cd deploy/gce && sudo docker compose up -d --build
```
