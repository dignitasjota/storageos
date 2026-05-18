# DEPLOYMENT

> Estado: **placeholder**. Se rellena en Fase 8 (Super Admin y facturación SaaS) o antes si necesitamos staging.

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
