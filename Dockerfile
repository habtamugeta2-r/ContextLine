FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY apps/demo/package.json apps/demo/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY apps/demo/package.json apps/demo/package.json
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/worker/package.json ./packages/worker/package.json
COPY --from=build --chown=node:node /app/packages/worker/dist ./packages/worker/dist
COPY --from=build --chown=node:node /app/deploy ./deploy
USER node
EXPOSE 9090
CMD ["node", "packages/worker/dist/cli.js"]
