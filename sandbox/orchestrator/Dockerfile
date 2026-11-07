FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# Quota de tokens du jour par utilisateur (voir src/patch-quota.js) : le build échoue si le code a changé et que le patch ne s'applique plus.
RUN node src/patch-quota.js
ENV NODE_ENV=production
EXPOSE 8080
# quota-reset.js ne fait rien sauf si QUOTA_RESET_ID a changé ; son échec n'empêche pas le démarrage.
CMD ["sh", "-c", "node src/quota-reset.js; exec node src/server.js"]
