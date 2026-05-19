# DEPLOYMENT

> Estado al cierre de **Fase 1F**: solo existe el entorno de **desarrollo local** con docker-compose. La topología de producción que sigue es la **prevista** según ADR-006; se completará en Fase 8 (Super Admin y facturación SaaS) o antes si necesitamos un entorno de staging.

## Desarrollo local (existente)

Arranque completo en `README.md`. Resumen de servicios levantados por `pnpm docker:up`:

| Servicio      | Imagen          | Puerto host                | Notas                                                           |
| ------------- | --------------- | -------------------------- | --------------------------------------------------------------- |
| postgres      | postgres:16     | `5433`                     | Roles `storageos` (admin) y `storageos_app` (RLS). Ver ADR-013. |
| redis         | redis:7         | `6380`                     | Reservado para Fase 4 (BullMQ). No se usa todavía.              |
| minio         | minio/minio     | `9010` (S3), `9011` (UI)   | Reservado para subidas de archivo (planos, documentos).         |
| mailpit       | axllent/mailpit | `1026` (SMTP), `8026` (UI) | Captura todos los emails en dev.                                |
| createbuckets | minio/mc        | one-shot                   | Crea buckets iniciales en MinIO.                                |

`.env` raíz tiene la configuración de docker-compose. Cada app (`apps/api/.env`, `apps/web/.env`) tiene sus propias variables (ver `.env.example` de cada uno). Las claves nuevas tras Fase 1F:

- `JWT_ACCESS_SECRET`, `JWT_ACCESS_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS` (Fase 1B).
- `JWT_2FA_PENDING_SECRET`, `JWT_2FA_PENDING_TTL_SECONDS` (Fase 1F).
- `MASTER_ENCRYPTION_KEY` — base64 de 32 bytes para AES-256-GCM de secretos TOTP. Generar con `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` (Fase 1F).
- `SMTP_*`, `WEB_BASE_URL` para los enlaces en los emails (Fase 1D).
- `COOKIE_DOMAIN`, `COOKIE_SECURE`, `COOKIE_SAMESITE` para el refresh cookie.
- `ALLOWED_ORIGINS` para CORS.

## Topología prevista (ADR-006)

- VPS único con Docker.
- **Portainer** gestiona los stacks.
- **Nginx Proxy Manager** (NPM) hace de reverse proxy y termina SSL con Let's Encrypt.
- Servicios en red Docker interna; solo NPM expone 80/443 al host.

## Stacks

- `storageos-api` — backend NestJS
- `storageos-web` — Next.js (modo producción `next start` detrás de NPM)
- `storageos-worker` — proceso BullMQ separado para jobs (facturación recurrente, PDFs, emails, dunning)
- `storageos-db` — PostgreSQL 16 (con backups cifrados a almacenamiento externo)
- `storageos-redis` — Redis 7
- `storageos-minio` — MinIO (con backups)
- `storageos-uptime` — Uptime Kuma

## Variables de entorno

Mismo nombre que en dev pero apuntando a hostnames de la red Docker interna (`postgres`, `redis`, `minio`). Se montan como **Docker secrets** en el servicio correspondiente; nunca en repo.

## Pipeline de despliegue (provisional)

1. Push a `main` → GitHub Actions construye imágenes Docker etiquetadas con el SHA.
2. Imágenes empujadas a un registry (GHCR o registry self-hosted).
3. Portainer detecta el nuevo tag y aplica `docker compose pull && up -d` por servicio.
4. Migraciones Prisma se aplican con `prisma migrate deploy` antes del rolling restart del API.

## Backups

- Postgres: `pg_dump` diario cifrado con GPG, subido a almacenamiento externo (S3/B2). Retención 30 días + 6 mensuales.
- MinIO: replicación a un bucket externo cifrado en otra región.

## Pendiente

- Definir registry concreto (GHCR vs self-hosted).
- Documentar el flujo de creación de tenant y onboarding (Fase 8).
- Runbook de recuperación ante desastre.
- Política de rotación de secretos.
