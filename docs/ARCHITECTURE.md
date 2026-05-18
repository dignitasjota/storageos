# ARCHITECTURE

Decisiones arquitecturales del proyecto. Cada decisión va con su justificación para que sea fácil revisarlas en el futuro.

## ADR-001: Monorepo con pnpm + Turborepo

**Decisión:** monorepo único.
**Por qué:** compartir tipos, DTOs y componentes UI entre backend y frontend sin duplicar; pipeline CI unificado; refactors atómicos.
**Alternativas descartadas:** repos separados (más fricción), Nx (más potente pero más complejo de lo que necesitamos).

## ADR-002: NestJS para backend

**Decisión:** NestJS sobre Node.js 20.
**Por qué:** arquitectura modular clara (módulos, controllers, services, guards), DI nativa, ecosistema TypeScript unificado con Next.js, excelente para SaaS multi-tenant.
**Alternativas descartadas:** Express puro (sin estructura), FastAPI (rompe la unidad TS).

## ADR-003: PostgreSQL + Prisma

**Decisión:** Postgres 16 como única BBDD, Prisma como ORM.
**Por qué:** transacciones, JSONB, Row-Level Security, full-text search, extensiones. Prisma da type-safety end-to-end y migraciones declarativas.
**Alternativas descartadas:** MySQL (peor JSON y RLS), TypeORM (peor DX), Drizzle (más nuevo, menor ecosistema).

## ADR-004: Multi-tenancy con shared schema + RLS

**Decisión:** todas las tablas con `tenant_id`, aisladas vía Row-Level Security de Postgres.
**Por qué:** balance óptimo entre coste, complejidad y aislamiento para nuestra escala objetivo (cientos de tenants).
**Cuándo reconsiderar:** si un tenant pesa más del 20% del total, considerar moverlo a una BBDD dedicada. Si superamos los 1000 tenants, evaluar sharding por región.

## ADR-005: Next.js 15 App Router

**Decisión:** Next.js con App Router y React Server Components donde tenga sentido.
**Por qué:** SSR/streaming gratis, mejor SEO para landing y portal público, ecosistema enorme, gran DX.

## ADR-006: Docker + VPS con Portainer + Nginx Proxy Manager

**Decisión:** despliegue en VPS único dockerizado, gestionado con Portainer, con NPM como reverse proxy y SSL.
**Por qué:** coste muy bajo, control total, infraestructura ya disponible, portable a cualquier cloud el día de mañana.
**Riesgos asumidos:** single point of failure, uptime ~99.5%. Mitigación: backups automáticos cifrados a almacenamiento externo + plan de migración listo.
**Cuándo reconsiderar:** al superar ~100-200 tenants activos o cuando se necesite SLA > 99.9%. Migrar entonces a Hetzner Cloud con managed Postgres + balancer, o AWS ECS.

## ADR-007: MinIO para almacenamiento de archivos

**Decisión:** MinIO autohospedado, S3-compatible.
**Por qué:** evita acoplarnos a AWS, mismo SDK que S3, fácil migrar a S3/R2/B2 después.

## ADR-008: BullMQ para colas

**Decisión:** BullMQ sobre Redis para todas las tareas asíncronas.
**Por qué:** facturación recurrente, generación de PDFs, envío de emails, dunning de morosidad, sincronización de accesos. Necesitamos jobs programados (cron) y retries.

## ADR-009: Stripe + GoCardless

**Decisión:** Stripe para tarjetas, GoCardless para SEPA. Capa de abstracción `PaymentGateway` para añadir Redsys en el futuro.
**Por qué:** Stripe es el estándar global, GoCardless lidera SEPA con comisiones bajas (~1%). Redsys es necesario solo si algún cliente lo exige.

## ADR-010: Resend / Brevo para emails

**Decisión:** Resend como primera opción.
**Por qué:** entregabilidad alta, API moderna, plan gratis razonable para empezar. Brevo como plan B si necesitamos SMS y WhatsApp en el mismo proveedor.
**Por qué NO autohospedar SMTP:** los IPs nuevos no llegan a inbox, marcado como spam, gestión de blacklists es un trabajo a tiempo completo.

## Diagrama de servicios (producción)

```
                    Internet
                       |
                       v
            Nginx Proxy Manager (SSL)
            /      |        |        \
           v       v        v         v
       Next.js  NestJS   MinIO   Uptime Kuma
                  |
                  +--> PostgreSQL
                  +--> Redis  <-- BullMQ Worker
```

Todos los servicios viven en una red Docker interna; solo NPM expone puertos al host.

## Flujo de datos crítico: facturación recurrente

1. Cron job (BullMQ scheduler) corre diariamente.
2. Identifica contratos con próxima factura debida.
3. Genera `invoice` + `invoice_items` aplicando reglas de pricing.
4. Genera PDF con Puppeteer y lo sube a MinIO.
5. Encola job de envío por email.
6. Si el método de pago está guardado, encola job de cobro automático.
7. Resultado del cobro actualiza `payment.status`; si falla, encola `dunning_action`.
8. Cada paso queda en `audit_logs`.

## Seguridad: defensa en profundidad

- **Red:** firewall del VPS solo abre 80/443; el resto, red Docker interna.
- **App:** rate limiting, validación estricta, CORS configurado, Helmet.
- **Auth:** JWT corto + refresh en httpOnly cookie, 2FA para roles sensibles.
- **BBDD:** RLS por tenant_id, usuario Postgres de la app sin permisos DDL.
- **Secretos:** nunca en repo, gestionados como variables de entorno y montados como Docker secrets en prod.
- **Backups:** cifrados con gpg antes de subir a almacenamiento externo.
