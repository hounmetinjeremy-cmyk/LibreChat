FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bash curl jq unzip python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
# Outils d'hébergeurs : Vercel, Cloudflare (wrangler), Fly. Render se pilote par son API avec curl.
RUN npm install -g --no-audit --no-fund vercel wrangler \
 && curl -fsSL https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh \
 && ln -sf /usr/local/bin/flyctl /usr/local/bin/fly
RUN useradd -m -s /bin/bash worker && mkdir /work && chown worker /work
WORKDIR /app
COPY package.json run.js ./
USER worker
ENV HOME=/home/worker
CMD ["node", "/app/run.js"]
