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
- `DEEPSEEK_API_KEY` : ta clé DeepSeek (celle du service, payée par les abonnements)

## 3. Lancer

```
sudo docker compose up -d --build
```

L'outil `dev-fix` est déjà branché dans `librechat.gce.yaml`.
(Si tu modifies `librechat.yaml` à la racine du dépôt, reporte le changement dans `librechat.gce.yaml`.)

## 4. Chaque utilisateur a son dev

Chaque utilisateur, dans LibreChat, ouvre les réglages de l'outil `dev-fix` et saisit **son propre token GitHub**
(token à créer sur GitHub : droits « Contents » et « Pull requests » en écriture, sur ses dépôts).
Ensuite l'outil travaille sur **ses** dépôts, dans **son** espace de travail, séparé des autres.

## 5. Utiliser

Écrire dans le chat, par exemple : « Dans mon dépôt Chap-money, j'ai un problème de paiement : ... ».
L'outil `dev_fix` cherche les fichiers, fait une seule requête au modèle, applique la correction sur une branche et ouvre une pull request. Rien ne touche la branche principale tant que l'utilisateur n'a pas validé la pull request.
Une correction peut durer 1 à 2 minutes.

Limites (modifiables dans `.env`) : `MAX_PARALLEL` corrections en même temps sur le serveur (les autres attendent leur tour), une correction à la fois par utilisateur, `MAX_FIX_PER_DAY` corrections par utilisateur et par jour.

## Si l'outil n'apparaît pas

```
sudo docker compose logs dev-fix
sudo docker compose logs librechat | grep -i mcp
```

## Mise à jour

```
cd LibreChat && git pull && cd deploy/gce && sudo docker compose up -d --build
```
