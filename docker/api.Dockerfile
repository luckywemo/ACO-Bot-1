FROM node:20-alpine
WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/opensea/package.json packages/opensea/
COPY packages/blockchain/package.json packages/blockchain/
COPY packages/monitoring/package.json packages/monitoring/
COPY packages/executor/package.json packages/executor/
COPY packages/wallet/package.json packages/wallet/
COPY packages/database/package.json packages/database/
COPY packages/notifications/package.json packages/notifications/

RUN npm install --omit=dev

# Source (tsx runs TypeScript directly — no build step).
COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "apps/api/src/index.ts"]
