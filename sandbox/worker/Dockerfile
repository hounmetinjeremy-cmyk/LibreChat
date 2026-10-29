FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash worker && mkdir /work && chown worker /work
WORKDIR /app
COPY package.json run.js ./
USER worker
ENV HOME=/home/worker
CMD ["node", "/app/run.js"]
