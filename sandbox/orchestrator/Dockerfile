FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN node src/patch-provider.js
RUN node src/patch-behavior.js
RUN node src/patch-jobguard.js
ENV NODE_ENV=production
EXPOSE 8080
# quota-reset.js ne fait rien sauf si QUOTA_RESET_ID a changé ; son échec n'empêche pas le démarrage.
CMD ["sh", "-c", "node src/quota-reset.js; exec node src/server.js"]
