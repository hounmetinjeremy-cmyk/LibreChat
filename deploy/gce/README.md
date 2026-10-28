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
- `VISION_KEYS` : `clé_deepseek,clé_gemini` (tes clés, séparées par une virgule : elles paient les tokens de l'abonnement)
- `DEEPSEEK_API_KEY` : ta clé DeepSeek (pour l'agent de code)

## 3. Lancer

```
sudo docker compose up -d --build
```

L'outil `dev-fix` est déjà branché dans `librechat.gce.yaml`.
(Si tu modifies `librechat.yaml` à la racine du dépôt, reporte le changement dans `librechat.gce.yaml`.)

## 4. Ce que chaque abonné reçoit (abonnement de 13 $ par mois)

- **80 messages par jour** (`MESSAGE_USER_MAX` dans `.env`).
- **2 $ de tokens de chat par mois** (section `balance` de `librechat.gce.yaml`).
- **1 $ de tokens pour l'agent de code par mois** (`FIX_BUDGET_USD` dans `.env`).
- Total : 3 $ de tokens par mois, payés avec tes clés.

À vérifier au premier test : envoie un message avec un compte test et regarde de combien baisse le solde. Les modèles « Aube » et « Soleil » ont des noms inventés : si LibreChat ne connaît pas leur prix, il en applique un par défaut, qui peut être trop haut ou trop bas.

## 5. Chaque utilisateur a son dev

Chaque utilisateur, dans LibreChat, ouvre les réglages de l'outil `dev-fix` et saisit **son propre token GitHub**
(token à créer sur GitHub : droits « Contents » et « Pull requests » en écriture, sur ses dépôts).
Ensuite l'agent travaille sur **ses** dépôts, dans **son** espace de travail, séparé des autres.

## 6. Utiliser

Écrire dans le chat, par exemple : « Dans mon dépôt Chap-money, j'ai un problème de paiement : ... ».
L'outil `dev_fix` lance un agent qui travaille en boucle sur le serveur : il cherche dans le code, lit les fichiers utiles, modifie, vérifie, recommence, puis ouvre une pull request. Le chat ne l'appelle qu'une fois. Rien ne touche la branche principale tant que l'utilisateur n'a pas validé la pull request.

- **Étapes** : 12 au maximum par tâche (`AGENT_MAX_STEPS` dans `.env` pour changer).
- **Durée** : de quelques dizaines de secondes à plusieurs minutes. La réponse n'arrive qu'à la fin.
- **Coût** : environ 0,01 à 0,04 $ par tâche. Le budget restant est indiqué à la fin de chaque réponse.
- **Limites actuelles** : l'agent lit et modifie le code, mais ne lance pas le programme ni les tests (cela demande un bac à sable isolé par utilisateur, à ajouter plus tard).

`MAX_PARALLEL` agents tournent en même temps sur le serveur (les autres attendent leur tour), un seul à la fois par utilisateur.

## Si l'outil n'apparaît pas

```
sudo docker compose logs dev-fix
sudo docker compose logs librechat | grep -i mcp
```

## Mise à jour

```
cd LibreChat && git pull && cd deploy/gce && sudo docker compose up -d --build
```
