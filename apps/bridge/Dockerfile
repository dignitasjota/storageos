# TrasterOS Bridge — agente ligero para la LAN del local (Raspberry / mini-PC).
# Multi-stage: compila con el monorepo y publica una imagen mínima.
FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter bridge... && pnpm --filter bridge build

FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /repo/apps/bridge/dist ./dist
# Monta bridge.config.json como volumen (o pásalo por BRIDGE_CONFIG_PATH).
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
