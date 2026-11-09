FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bash curl jq unzip python3 python3-pip chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
# Outils d'hébergeurs : Vercel, Cloudflare (wrangler), Fly. Render se pilote par son API avec curl.
# bun : installation de paquets beaucoup plus rapide que npm (le conteneur repart de zéro à chaque session).
RUN npm install -g --no-audit --no-fund vercel wrangler bun \
 && curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh \
 && ln -sf /usr/local/bin/flyctl /usr/local/bin/fly
# Cache de bun préchauffé avec les paquets de l'application rider (warm/package.json) : une installation
# n'a plus qu'à copier les paquets au lieu de les télécharger. Si le préchauffage échoue, l'image est construite quand même.
ENV BUN_INSTALL_CACHE_DIR=/opt/bun-cache
COPY warm/package.json /tmp/warm/package.json
RUN mkdir -p /opt/bun-cache \
 && (cd /tmp/warm && bun install --ignore-scripts --no-progress > /tmp/warm.log 2>&1 || echo "préchauffage du cache ignoré") \
 && rm -rf /tmp/warm /tmp/warm.log \
 && chmod -R a+rwX /opt/bun-cache
RUN useradd -m -s /bin/bash worker && mkdir /work && chown worker /work
WORKDIR /app
COPY package.json run.js output-filter.js ./
USER worker
ENV HOME=/home/worker
CMD ["node", "/app/run.js"]
