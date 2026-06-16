# =============================================================================
# apps/worker/Dockerfile - Imagen de produccion del worker BullMQ.
#
# Build context esperado: RAIZ DEL MONOREPO (no apps/worker), porque
# necesitamos resolver el workspace pnpm completo. En docker-compose.prod.yml
# usamos `context: .` y `dockerfile: apps/worker/Dockerfile`.
#
# Multi-stage:
#   1. deps     - instala dependencias del monorepo con pnpm (cacheable).
#   2. builder  - genera Prisma client, compila @storageos/shared,
#                 @storageos/database, apps/api (necesario porque el worker
#                 importa los modulos del API via tsc paths `@api/*`) y
#                 finalmente apps/worker a dist/.
#   3. runner   - imagen final minima con solo el runtime + Chromium para
#                 Puppeteer (lo usan reports y verifactu/invoices).
# =============================================================================

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.15.0

# -----------------------------------------------------------------------------
# Stage 1: deps - Resuelve el grafo completo del workspace pnpm.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG PNPM_VERSION
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Puppeteer usa el Chromium del sistema (instalado en el runner); evita que su
# postinstall descargue uno durante `pnpm install` (falla en la imagen slim).
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY turbo.json tsconfig.json ./

COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/eslint-config/package.json ./packages/config/eslint-config/
COPY packages/config/prettier-config/package.json ./packages/config/prettier-config/
COPY packages/config/tailwind-config/package.json ./packages/config/tailwind-config/
COPY packages/config/tsconfig/package.json ./packages/config/tsconfig/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: builder - Compila Prisma client + shared + api + worker.
# -----------------------------------------------------------------------------
FROM deps AS builder

WORKDIR /repo

COPY packages/database ./packages/database
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY packages/config ./packages/config
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# Orden de build: shared -> database -> worker. El worker tira de modulos
# del API via tsc paths (@api/*), no necesita el dist del API.
RUN pnpm --filter @storageos/shared build \
 && pnpm --filter @storageos/database build \
 && pnpm --filter worker build

# Pruning: dejamos solo dependencias de produccion del workspace worker.
RUN pnpm --filter worker --prod deploy /out \
 # `pnpm deploy` NO incluye de forma fiable el Prisma client generado
 # (.prisma/client) — deja el stub -> "@prisma/client did not initialize".
 # Copiamos el client ya generado por el build de database al /out.
 && PRISMA_SRC="$(find /repo/node_modules/.pnpm -type d -path '*@prisma+client@*/node_modules/.prisma' | head -1)" \
 && PRISMA_DST="$(find /out/node_modules/.pnpm -type d -path '*@prisma+client@*/node_modules' | head -1)/.prisma" \
 && rm -rf "$PRISMA_DST" && cp -r "$PRISMA_SRC" "$PRISMA_DST" \
 && echo "[prisma] client generado copiado a /out"

# -----------------------------------------------------------------------------
# Stage 3: runner - Imagen final.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

# Chromium nativo para Puppeteer (lo usan reports y contratos/invoices PDFs).
# tini gestiona senales correctamente cuando node es PID 1.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --create-home --home-dir /home/worker worker

WORKDIR /app

COPY --from=builder --chown=worker:nodejs /out/node_modules ./node_modules
COPY --from=builder --chown=worker:nodejs /out/package.json ./package.json
COPY --from=builder --chown=worker:nodejs /repo/apps/worker/dist ./dist

# Nota: Prisma client + engines + dist/schema/migraciones de @storageos/database
# ya vienen en /out/node_modules via `pnpm deploy` (verificado).

USER worker

# Sin EXPOSE: el worker no expone puertos. La salud se monitoriza desde
# fuera observando metricas de BullMQ (queue depth, completed/failed) y los
# logs del contenedor.

ENTRYPOINT ["/usr/bin/tini", "--"]
# Por el `rootDir: ".."` en tsconfig.build.json (necesario para que tsc
# acepte imports a `../api/src/**` via paths `@api/*`), el entry compilado
# queda en `dist/worker/src/main.js`.
CMD ["node", "dist/worker/src/main.js"]
