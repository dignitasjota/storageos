# =============================================================================
# apps/api/Dockerfile - Imagen de producción del backend NestJS.
#
# Build context esperado: RAIZ DEL MONOREPO (no apps/api), porque necesitamos
# resolver el workspace pnpm completo. En docker-compose.prod.yml usamos
# `context: .` y `dockerfile: apps/api/Dockerfile`.
#
# Multi-stage:
#   1. deps     - instala dependencias del monorepo con pnpm (cacheable).
#   2. builder  - genera Prisma client, compila @storageos/shared, @storageos/database
#                 y apps/api a dist/.
#   3. runner   - imagen final minima con solo el runtime + Chromium para Puppeteer.
# =============================================================================

# Versiones fijadas (Node coincide con .nvmrc del repo).
ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.15.0

# -----------------------------------------------------------------------------
# Stage 1: deps - Resuelve el grafo completo del workspace pnpm.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG PNPM_VERSION
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Habilita corepack y fija la version de pnpm declarada en package.json.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Dependencias del sistema para compilar nativos (@node-rs/argon2 requiere
# python3 + make + g++ si no encuentra prebuilds).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Copiamos primero solo los manifests para maximizar cache de capas.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY turbo.json tsconfig.json ./

# Manifests de cada workspace (sin codigo fuente todavia).
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/eslint-config/package.json ./packages/config/eslint-config/
COPY packages/config/prettier-config/package.json ./packages/config/prettier-config/
COPY packages/config/tailwind-config/package.json ./packages/config/tailwind-config/
COPY packages/config/tsconfig/package.json ./packages/config/tsconfig/

# Instalacion completa offline-friendly. --frozen-lockfile garantiza
# determinismo entre dev y prod.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage 2: builder - Compila Prisma client + shared + api.
# -----------------------------------------------------------------------------
FROM deps AS builder

WORKDIR /repo

# Copiamos el codigo fuente real (los manifests ya estaban en deps).
COPY packages/database ./packages/database
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY packages/config ./packages/config
COPY apps/api ./apps/api

# Reaplicamos install por si llegaron nuevos package.json al copiar
# (idempotente, usa el cache anterior).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# Orden de build: shared primero (lo importan database/api/web),
# luego database (genera Prisma client + dist), finalmente la API.
RUN pnpm --filter @storageos/shared build \
 && pnpm --filter @storageos/database build \
 && pnpm --filter api build

# Pruning: dejamos solo dependencias de produccion del workspace api.
# `pnpm deploy` resuelve transitivos y crea un node_modules autocontenido.
RUN pnpm --filter api --prod deploy /out

# -----------------------------------------------------------------------------
# Stage 3: runner - Imagen final.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

# Chromium nativo de Debian + librerias para Puppeteer (mas ligero y
# parcheado que descargar Chromium dentro del modulo).
# tini gestiona senales correctamente cuando node es PID 1.
# curl para healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    tini \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Variables para que Puppeteer NO descargue su propio Chromium y use
# el del sistema. Hay que setear ambas: skip-download y executable-path.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3001

# Usuario sin privilegios.
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --create-home --home-dir /home/api api

WORKDIR /app

# Solo el bundle pruned + el dist compilado.
# `pnpm deploy` ya colapso los workspaces internos en /out/node_modules.
COPY --from=builder --chown=api:nodejs /out/node_modules ./node_modules
COPY --from=builder --chown=api:nodejs /out/package.json ./package.json
COPY --from=builder --chown=api:nodejs /repo/apps/api/dist ./dist

# Prisma client + engines (binarios necesarios en runtime).
# pnpm deploy normalmente los copia, pero los duplicamos por si el
# pruning agresivo los hubiera dejado fuera del closure de produccion.
COPY --from=builder --chown=api:nodejs /repo/packages/database/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=api:nodejs /repo/packages/database/dist ./node_modules/@storageos/database/dist
COPY --from=builder --chown=api:nodejs /repo/packages/database/package.json ./node_modules/@storageos/database/package.json
COPY --from=builder --chown=api:nodejs /repo/packages/database/prisma ./node_modules/@storageos/database/prisma

USER api

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:3001/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
