# StorageOS

SaaS multi-tenant para la gestión integral de locales de self-storage.

> Estado: **Fase 0 — setup del monorepo**. Ver [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Stack

- **Backend:** NestJS + Prisma + PostgreSQL 16 + Redis + BullMQ
- **Frontend:** Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui
- **Infra dev:** Docker Compose (Postgres, Redis, MinIO, Mailpit)
- **Monorepo:** pnpm workspaces + Turborepo

## Requisitos

- Node.js **20.18.x** (ver `.nvmrc`)
- pnpm **9.x** (vía Corepack: `corepack enable`)
- Docker + Docker Compose

## Arranque

```bash
# 1. Instalar dependencias
pnpm install

# 2. Crear .env raíz (para docker-compose)
cp .env.example .env

# 3. Crear .env de cada app
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 4. Levantar servicios de infraestructura
pnpm docker:up

# 5. Generar cliente Prisma y aplicar migraciones
pnpm db:generate
pnpm db:migrate

# 6. Arrancar API y Web en paralelo
pnpm dev
```

URLs locales:

| Servicio        | URL                            |
| --------------- | ------------------------------ |
| Web             | http://localhost:3000          |
| API             | http://localhost:3001/health   |
| Postgres        | localhost:5433                 |
| Redis           | localhost:6380                 |
| MinIO consola   | http://localhost:9011          |
| Mailpit UI      | http://localhost:8026          |

## Estructura del monorepo

```
apps/
  api/         Backend NestJS
  web/         Frontend Next.js
packages/
  database/    Prisma schema + cliente
  shared/      Tipos y DTOs compartidos
  ui/          Componentes UI compartidos
  config/      ESLint, TS, Prettier, Tailwind compartidos
docker/        Configuración Docker adicional
docs/          Documentación
```

## Documentación

- [`CLAUDE.md`](CLAUDE.md) — contexto del proyecto
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — fases del proyecto
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — decisiones arquitecturales
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — modelo de datos
- [`docs/API.md`](docs/API.md) — convenciones de la API
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — despliegue
