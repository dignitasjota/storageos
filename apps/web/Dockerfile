# =============================================================================
# apps/web/Dockerfile - Imagen de producción del frontend Next.js 15.
#
# Build context esperado: RAIZ DEL MONOREPO. Igual que apps/api/Dockerfile,
# necesitamos resolver el workspace pnpm completo (transpilamos packages/ui
# y dependemos de packages/shared compilado).
#
# Estrategia: `next build` con `output: 'standalone'` (ver next.config.mjs)
# genera `.next/standalone/` con server.js + node_modules minimos. La imagen
# final solo copia esa carpeta, `.next/static/` y `public/`.
# =============================================================================

ARG NODE_VERSION=20.18.1
ARG PNPM_VERSION=9.15.0

# -----------------------------------------------------------------------------
# Stage 1: deps
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ARG PNPM_VERSION
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Build-time tools por si algun nativo necesita compilarse.
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
# Stage 2: builder
# -----------------------------------------------------------------------------
FROM deps AS builder

WORKDIR /repo

COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui
COPY packages/config ./packages/config
COPY apps/web ./apps/web

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# NEXT_PUBLIC_* es resolved en build-time: las URLs publicas DEBEN inyectarse
# como --build-arg en el compose para que queden embebidas en el bundle.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN pnpm --filter @storageos/shared build \
 && pnpm --filter web build

# -----------------------------------------------------------------------------
# Stage 3: runner
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --create-home --home-dir /home/web web

WORKDIR /app

# Estructura producida por `output: 'standalone'` con monorepo:
#   .next/standalone/  -> root del workspace pruned (apps/web/server.js dentro)
#   .next/static/      -> estaticos hashed
#   public/            -> assets sin hash
#
# Como declaramos outputFileTracingRoot = ../../ (raiz monorepo) en
# next.config.mjs, el standalone es la raiz del monorepo y server.js
# vive en apps/web/server.js dentro del standalone.
COPY --from=builder --chown=web:nodejs /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=web:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=web:nodejs /repo/apps/web/public ./apps/web/public

USER web

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:3000/ || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/web/server.js"]
