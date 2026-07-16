# TrasterOS

SaaS multi-tenant para la gestión integral de locales de self-storage.

> Estado: **MVP COMPLETO + Veri\*Factu real + compliance/observabilidad + hardening operacional + robustez técnica pre-venta + hardening final pre-deploy + cierre de TODOs y operabilidad + RGPD tenant + pagos SEPA + portal de cobro + auto-charge** — Fases 1 a 17 cerradas. Listo para desplegar, vender, emitir facturas F1/F2 conformes a AEAT, rectificarlas por diferencias o sustitución, reconciliar pendings AEAT con polling automático, forzar 2FA al owner/manager, correr smoke tests Playwright en CI, separar el worker BullMQ del API en producción, exponer eventos a integradores externos (Zapier, n8n, ...) vía API keys con scopes enforced + webhooks HMAC con dashboard de retry manual, anonimizar un tenant completo (derecho al olvido RGPD), y cobrar por SEPA + tarjeta con auto-charge y pago self-service desde el portal del inquilino.
> Fase 8 incluye: panel super admin con impersonation auditada + soporte de tickets + Stripe Billing SaaS (Checkout + Customer Portal) + Docker prod + `docs/DEPLOYMENT.md` paso a paso.
> Fase 9 (hardening pre-MVP, 2026-05-20): 2FA TOTP super admin + refresh cookie httpOnly `path=/admin` con rotación paranoid + recovery codes single-use + seed CLI super admin idempotente + AeatClient abstracto (`AEAT_MODE=stub|sandbox|production`) + Resend producción documentado.
> Fase 10 (Veri\*Factu real, 2026-05-20): `tenant_aeat_credentials` cifrado AES-GCM + upload UI de PKCS#12 en `/settings/billing/verifactu` + `VerifactuXmlBuilder` conforme al XSD AEAT + `RealAeatClient` con mTLS via `https.Agent` + cola BullMQ con retry exponencial + `POST /billing/invoices/:id/resend-aeat` + `<VerifactuBadge>` en facturas.
> Fase 11 (compliance + observabilidad post-MVP, 2026-05-20): tabla global `security_events` + endpoint `/admin/security-events` con cron de limpieza a 90d + histórico de `tenant_aeat_credentials` (drop UNIQUE + rotación via `$transaction` + `GET /billing/aeat-credentials/history`) + CSP `Report-Only` en panel autenticado + endpoint `/api/csp-report` + rectificativas Veri\*Factu R1-R5 (`POST /invoices/:id/rectify` + `<TipoRectificativa>I</TipoRectificativa>` en XML AEAT).
> Fase 12 (hardening operacional adicional, 2026-05-20): flag tenant `requireTwoFactorForManagers` con flow de enrolment forzado en login y página pública `/security/enrolment/[token]` + `SecurityAlertsService` con cron `*/5 * * * *` sobre `security_events` y email al `SECURITY_ALERT_EMAIL` + tabla global `super_admin_audit_logs` con endpoint `/admin/audit-logs` y página dedicada + 5 smoke tests Playwright E2E en `apps/web/e2e/`.
> Fase 13 (robustez técnica pre-venta, 2026-05-20): worker separado `apps/worker` con processors BullMQ y crons fuera del proceso API (Dockerfile + servicio en `docker-compose.prod.yml`) + OpenAPI 3.x en `/api/docs` (`@nestjs/swagger`) + API versioning URI `/v1/` con legacy redirect 308 + F2 (factura simplificada) con `customer_id NULLABLE` y límites 400€/3000€ + rectificativas por sustitución (`<TipoRectificativa>S</...>` + bloque `<ImporteRectificacion>`) + CSP enforce promovida desde Report-Only + workflow `.github/workflows/e2e.yml` con Playwright en CI no bloqueante.
> Fase 14 (hardening final pre-deploy, 2026-05-20): flag `ENABLE_WORKERS_IN_API` (default `true`, `false` en producción) que apaga Processors + Crons en el API cuando arranca el worker aparte + refactor service/processor + tests del worker con `ioredis-mock` via `moduleNameMapper` (bootstrap 2/2 verde tras añadir `FilesModule` a `WorkerModule`) + API keys `sk_live_<tenantId>.<secret>` revealed-once con `ApiKeyGuard` Bearer + webhooks salientes con HMAC SHA-256 al estilo Stripe (`X-Storageos-Signature: t=<ts>,v1=<hmac>`) + cola BullMQ `webhooks` con retry 3× exponencial + listeners `invoice.paid/issued/overdue`, `contract.signed`, `lead.created` + UI tab `/settings/integrations`.
> Fase 15 (cierre de TODOs y operabilidad, 2026-05-21): AEAT `getStatus` polling con XML SOAP `ConsultaFactuSistemaFacturacion` + `VerifactuStatusPollerCron` cada 15 min sobre invoices `pending` huérfanas (batch `take: 50`) + endpoint manual `POST /v1/billing/invoices/:id/refresh-aeat-status` + botón "Consultar AEAT" en `<VerifactuBadge>` + dashboard `/settings/webhooks/[id]` con deliveries cursor + filtros + retry manual `POST /v1/settings/webhooks/:webhookId/deliveries/:deliveryId/retry` (reset `attempts=0` antes de encolar) + scopes API keys enforced con decorador `@RequireScope(scope)` + whitelist 5 scopes (`invoices:read/write`, `contracts:read`, `customers:read`, `webhooks:trigger`) + endpoint `GET /v1/integrations/whoami` como ejemplo + UI multiselect scopes en dialog crear API key.
> Fase 16 (cierre de TODOs residuales + RGPD tenant, 2026-06-09): tests del worker (`worker-bootstrap` 2/2) y del flag (`workers-flag` 3/3) activados desde `describe.skip` + `email_reminder` del dunning conectado al outbox de comunicaciones (`CommunicationsService.enqueue`, plantilla `invoice_overdue_email`) + fix de seguridad `AdminGuard` en el catálogo de planes SaaS (antes `@Roles('owner')`) + `SecurityThrottlerGuard` que persiste `login_failed_throttled`/`register_throttled`/`password_reset_throttled` en `security_events` + anonimización RGPD del tenant (`POST /admin/tenants/:id/anonymize` + UI con confirmación por slug en `/admin/tenants/[id]`, preserva facturas).
> Fase 17 (pagos SEPA + portal de cobro + hardening pre-deploy, 2026-06-12): webhooks Stripe idempotentes (`processed_stripe_events`) + fin del doble-conteo de `amountPaid` + SEPA Direct Debit vía Stripe `sepa_debit` con disputes/R-transactions + self-service de IBAN y pago de facturas en el portal del inquilino + auto-charge opt-in al emitir factura (con emisión por fin de `domain.invoice_issued`) + Sentry en API/worker + `GET /health/ready` y `GET /health/worker` + reparación del historial de migraciones (timestamps que rompían BD nuevas) + dinero en céntimos enteros + heartbeat de workers + visibilidad de colas en `/admin/queues`.
> Detalle por sub-fase en [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Stack

- **Backend:** NestJS 11 + Prisma 6 + PostgreSQL 16, nestjs-pino, nestjs-zod, passport-jwt, @nestjs/throttler, @node-rs/argon2, otpauth, BullMQ + Redis + @nestjs/schedule (facturación recurrente, dunning), Stripe SDK, puppeteer (PDF), qrcode (QR Verifactu), React Email + nodemailer.
- **Frontend:** Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v3 + shadcn/ui, TanStack Query + TanStack Table v8, Zustand, react-hook-form + Zod, next-intl, next-themes, qrcode.react, react-konva (editor visual), Recharts (dashboards).
- **Infra dev:** Docker Compose (Postgres, Redis, MinIO, Mailpit).
- **Monorepo:** pnpm workspaces + Turborepo.

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

# 5. Generar cliente Prisma, aplicar migraciones y sembrar datos demo
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 6. Arrancar API y Web en paralelo
pnpm dev
```

URLs locales:

| Servicio      | URL                          |
| ------------- | ---------------------------- |
| Web           | http://localhost:3000        |
| API           | http://localhost:3001/health |
| Postgres      | localhost:5433               |
| Redis         | localhost:6380               |
| MinIO consola | http://localhost:9011        |
| Mailpit UI    | http://localhost:8026        |

### Credenciales del seed demo

Sembradas por `pnpm db:seed` (valores por defecto, configurables en `packages/database/.env`):

| Campo    | Valor                                          |
| -------- | ---------------------------------------------- |
| Tenant   | `demo-storage` (trial 14 días en plan Starter) |
| Email    | `jota@storageos.local`                         |
| Password | `Jota69`                                       |

### Scripts de base de datos

| Script             | Acción                                                          |
| ------------------ | --------------------------------------------------------------- |
| `pnpm db:generate` | Regenera el cliente Prisma a partir del schema                  |
| `pnpm db:migrate`  | Aplica migraciones pendientes (dev)                             |
| `pnpm db:seed`     | Ejecuta el seed de desarrollo (idempotente)                     |
| `pnpm db:reset`    | Borra la BD, reaplica todas las migraciones y reejecuta el seed |
| `pnpm db:studio`   | Abre Prisma Studio en http://localhost:5555                     |

> Los scripts `db:*` viven en el `package.json` raíz. Desde dentro de un sub-paquete usa `pnpm -w run db:xxx` para invocarlos contra el workspace.

### Tests

| Comando                                  | Qué corre                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm -r typecheck`                      | `tsc --noEmit` en cada paquete                                           |
| `pnpm -r lint`                           | ESLint con `--max-warnings=0` en todos los paquetes                      |
| `pnpm --filter @storageos/database test` | Vitest: uuid_v7, RLS, seed (11/11)                                       |
| `pnpm --filter api test:e2e`             | Jest + Supertest contra Postgres + Mailpit reales, `--runInBand` (59/59) |
| `pnpm --filter web build`                | Build de producción de Next.js (verifica rutas estáticas y dinámicas)    |

Los e2e del backend asumen que `pnpm docker:up` está corriendo (Postgres, Mailpit). El throttler aplica `skipIf` cuando `NODE_ENV=test`.

### Roles de Postgres

- `storageos` (admin) — lo usan Prisma migrate y el seed. Owner de las tablas, bypassea RLS.
- `storageos_app` (restringido) — lo usa `apps/api`. Sin DDL y sometido a las políticas Row-Level Security. Cualquier query sin tenant context activo devuelve 0 filas.

Ver `docs/DATA_MODEL.md` para detalles de RLS y el helper `withTenantContext`.

## Flujo de contribución (PR + gate de CI)

`main` está protegida: solo avanza vía **Pull Request** y únicamente si el gate
de smoke tests **`Smoke E2E (Playwright)`** está verde. Así, lo que despliega
Portainer (que hace `pull` de `main`) nunca incluye un cambio que rompa el
registro, la facturación, el panel admin o el widget.

### Ciclo por cada cambio

```bash
# 1. Rama nueva desde main
git checkout main && git pull
git checkout -b feat/lo-que-sea        # o fix/..., chore/...

# 2. Commit(s) en la rama (Conventional Commits)
git add -A
git commit -m "feat: ..."

# 3. Push de la RAMA (no de main)
git push -u origin feat/lo-que-sea
```

Después, con la GitHub CLI (`gh`):

```bash
gh pr create --fill --base main        # crea el PR con título/cuerpo del commit
gh pr checks --watch                    # espera y muestra el gate en vivo (~3-5 min)
gh pr merge --squash --delete-branch    # mergea cuando esté verde + borra la rama

# 4. Sincroniza tu local
git checkout main && git pull
```

> Alternativa "fire-and-forget": `gh pr merge --squash --auto --delete-branch`
> (requiere _Allow auto-merge_ en Settings → General) deja el PR programado para
> mergearse **solo** en cuanto el gate pase.

### Qué dispara el despliegue

El merge a `main` es lo que mueve la rama → Portainer hace `pull` (igual que
antes lo hacía el `push` directo). Si redespliegas a mano desde Portainer, lo
haces **después del merge**. El gate garantiza que ese `main` está verde.

### Reglas de la branch protection (GitHub → Settings → Branches → `main`)

- ✅ **Require status checks to pass before merging** → check `Smoke E2E (Playwright)`.
- ✅ **Require a pull request before merging** (sin esto, los `push` directos a
  `main` se saltan el gate).
- ✅ **Do not allow bypassing** (opcional pero recomendado en solo-dev: te frena
  también a ti como admin).

## Funcionalidad disponible

Resumen de lo implementado al cierre de Fase 1F. La especificación completa, incluyendo bodies y códigos de error, está en [`docs/API.md`](docs/API.md).

| Área                             | Endpoints / Páginas                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth                             | `POST /auth/register · /login · /refresh · /logout · /logout-all`, `GET /auth/me`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Email                            | `POST /auth/verify-email · /resend-verification · /password/forgot · /password/reset`                                                                                                                                                                                                                                                                                                                                                                                              |
| Users                            | `GET/PATCH/DELETE /users[/:id]`, `POST /users/:id/transfer-ownership`, `PATCH /me`, `POST /me/change-password`                                                                                                                                                                                                                                                                                                                                                                     |
| Invitations                      | `GET/POST /invitations`, `POST /invitations/:id/revoke · :id/resend`, `GET /invitations/token/:token`, `POST /invitations/token/:token/accept`                                                                                                                                                                                                                                                                                                                                     |
| 2FA TOTP                         | `GET /auth/2fa/status`, `POST /auth/2fa/setup · /verify · /disable · /recovery-codes/regenerate · /challenge`                                                                                                                                                                                                                                                                                                                                                                      |
| Facilities (Fase 2)              | `GET/POST/PATCH/DELETE /facilities[/:id]`, `GET/POST /facilities/:id/floors`, `PATCH/DELETE /floors/:id`, `POST /floors/:id/plan-upload-url`, `PATCH /floors/:id/plan`, `PATCH /floors/:id/units-layout`                                                                                                                                                                                                                                                                           |
| Unit types (Fase 2)              | `GET/POST/PATCH/DELETE /unit-types[/:id]`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Units (Fase 2)                   | `GET/POST/PATCH/DELETE /units[/:id]`, `POST /units/:id/change-status`, `GET /units/:id/history`                                                                                                                                                                                                                                                                                                                                                                                    |
| Dashboard (Fase 2)               | `GET /dashboard/occupancy`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Frontend público                 | `/`, `/login`, `/register`, `/verify-email-sent`, `/verify-email/[token]`, `/forgot-password`, `/forgot-password-sent`, `/reset-password/[token]`, `/invite/[token]`                                                                                                                                                                                                                                                                                                               |
| Customers (Fase 3)               | `GET/POST/PATCH/DELETE /customers[/:id]`, `POST /customers/:id/kyc`, `GET/POST /customers/:id/documents`, `POST /customers/:id/documents/upload-url`, `DELETE /documents/:id`                                                                                                                                                                                                                                                                                                      |
| Contracts (Fase 3)               | `GET/POST/PATCH /contracts[/:id]`, `POST /contracts/:id/{sign,request-end,end,cancel,change-price,generate-pdf,notes}`, `GET /contracts/:id/events`                                                                                                                                                                                                                                                                                                                                |
| Reservations (Fase 3)            | `GET/POST /reservations[/:id]`, `POST /reservations/:id/{confirm,cancel,convert-to-contract}`, `POST /reservations/expire-due`                                                                                                                                                                                                                                                                                                                                                     |
| Invoice series (Fase 4)          | `GET/POST/PATCH /invoice-series[/:id]`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Invoices (Fase 4)                | `GET/POST/PATCH /invoices[/:id]`, `POST /invoices/:id/{issue,cancel,refund,mark-paid,generate-pdf}`, `POST /invoices/jobs/run-recurring`                                                                                                                                                                                                                                                                                                                                           |
| Payments (Fase 4)                | `GET /payments`, `POST /payments/invoices/:id/charge`, `GET/POST /customers/:id/payment-methods`, `POST /payment-methods/setup-intent`, `DELETE /payment-methods/:id`                                                                                                                                                                                                                                                                                                              |
| Webhooks (Fase 4)                | `POST /webhooks/stripe` (verifica firma HMAC con `STRIPE_WEBHOOK_SECRET`)                                                                                                                                                                                                                                                                                                                                                                                                          |
| Dunning + RGPD (Fase 4)          | `GET /dunning`, `GET/POST /rgpd/requests`, `GET /rgpd/customers/:id/export`, `POST /rgpd/customers/:id/anonymize`                                                                                                                                                                                                                                                                                                                                                                  |
| Portal cliente (Fase 4)          | Públicos: `POST /portal/login/{request,consume}`, `GET /portal/me/invoices`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Communications (Fase 5)          | `GET /communications[/:id]`, `POST /communications`, `POST /communications/:id/retry`                                                                                                                                                                                                                                                                                                                                                                                              |
| Message templates (Fase 5)       | `GET/POST /message-templates`, `GET/PATCH/DELETE /message-templates/:id`, `POST /message-templates/preview`                                                                                                                                                                                                                                                                                                                                                                        |
| Automations (Fase 5)             | `GET/POST /automations`, `PATCH/DELETE /automations/:id`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Leads (Fase 5)                   | `GET/POST/PATCH/DELETE /leads[/:id]`, `POST /leads/:id/{transition,convert}`                                                                                                                                                                                                                                                                                                                                                                                                       |
| Widget público (Fase 5)          | Públicos: `GET /public/widget/:slug/facilities`, `POST /public/widget/:slug/leads`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tasks (Fase 6)                   | `GET/POST/PATCH/DELETE /tasks[/:id]`, `POST /tasks/:id/transition`, `GET/POST /tasks/:id/comments`                                                                                                                                                                                                                                                                                                                                                                                 |
| Incidents (Fase 6)               | `GET/POST/PATCH/DELETE /incidents[/:id]`, `POST /incidents/:id/transition`, `GET/POST /incidents/:id/comments`                                                                                                                                                                                                                                                                                                                                                                     |
| Products (Fase 6)                | `GET/POST/PATCH/DELETE /products[/:id]`, `GET /products/:id/stock`, `POST /products/:id/stock/adjust`, `PUT /products/:id/stock`                                                                                                                                                                                                                                                                                                                                                   |
| Product sales (Fase 6)           | `GET /product-sales[/:id]`, `POST /product-sales`, `POST /product-sales/:id/cancel`                                                                                                                                                                                                                                                                                                                                                                                                |
| Analytics (Fase 6)               | `GET /analytics/{occupancy,churn,aging,leads-funnel}`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Reports (Fase 6)                 | `GET /reports/catalog`, `GET /reports[/:id]`, `POST /reports/run`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Access credentials (Fase 7)      | `GET/POST /access/credentials`, `GET/PATCH /access/credentials/:id`, `POST /access/credentials/:id/{rotate,suspend,resume,revoke}`                                                                                                                                                                                                                                                                                                                                                 |
| Access devices (Fase 7)          | `GET/POST /access/devices`, `GET/PATCH/DELETE /access/devices/:id`, `POST /access/devices/:id/{regenerate-api-key,ping}`                                                                                                                                                                                                                                                                                                                                                           |
| Access verify (Fase 7)           | Público: `POST /access/verify` con header `X-Device-Key`. `GET /access/logs[/:id]` para audit trail                                                                                                                                                                                                                                                                                                                                                                                |
| Super admin auth (Fase 8 + 9)    | `POST /admin/auth/login` (con flujo 2FA), `POST /admin/auth/refresh` (cookie httpOnly `super_admin_refresh`), `POST /admin/auth/logout · /logout-all`, `GET /admin/auth/me`, `GET /admin/auth/2fa/status`, `POST /admin/auth/2fa/{setup,verify,disable,challenge,recovery-codes/regenerate}`                                                                                                                                                                                       |
| Super admin tenants (Fase 8)     | `GET /admin/tenants[/:id]`, `POST /admin/tenants/:id/{suspend,reactivate,extend-trial,impersonate}`                                                                                                                                                                                                                                                                                                                                                                                |
| Super admin metrics (Fase 8)     | `GET /admin/metrics`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Support tickets (Fase 8)         | Tenant: `GET/POST /support/tickets[/:id]`, `POST /support/tickets/:id/messages`. Admin: idem bajo `/admin/support/tickets/*` + `transition`, `assign`                                                                                                                                                                                                                                                                                                                              |
| SaaS billing (Fase 8)            | `GET /settings/saas-billing`, `POST /settings/saas-billing/{checkout,portal}`. Webhook `customer.subscription.*` y `invoice.payment_*` integrados                                                                                                                                                                                                                                                                                                                                  |
| Subscription plans (Fase 8)      | `GET /subscription-plans` (público), `GET/POST/PATCH/DELETE /subscription-plans/admin/*`                                                                                                                                                                                                                                                                                                                                                                                           |
| Frontend privado                 | `/dashboard`, `/facilities[/:id]`, `/units[/:id]`, `/customers[/:id]`, `/contracts`, `/contracts/new`, `/contracts/:id`, `/reservations`, `/invoices[/:id]`, `/payments`, `/leads`, `/communications`, `/message-templates`, `/automations`, `/tasks`, `/incidents`, `/products`, `/analytics`, `/reports`, `/access/{credentials,devices,logs}`, `/settings/{users,profile,security,billing,widget}`, `/admin/{login,security,metrics,tenants,tenants/[id],support,support/[id]}` |
| Frontend público (cliente final) | `/portal/login`, `/portal/consume`, `/widget/[slug]`                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
