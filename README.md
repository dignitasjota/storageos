# StorageOS

SaaS multi-tenant para la gestión integral de locales de self-storage.

> Estado: **MVP COMPLETO + Veri\*Factu real** — Fases 1 a 10 cerradas. Listo para desplegar, vender y emitir facturas conformes a AEAT.
> Fase 8 incluye: panel super admin con impersonation auditada + soporte de tickets + Stripe Billing SaaS (Checkout + Customer Portal) + Docker prod + `docs/DEPLOYMENT.md` paso a paso.
> Fase 9 (hardening pre-MVP, 2026-05-20): 2FA TOTP super admin + refresh cookie httpOnly `path=/admin` con rotación paranoid + recovery codes single-use + seed CLI super admin idempotente + AeatClient abstracto (`AEAT_MODE=stub|sandbox|production`) + Resend producción documentado.
> Fase 10 (Veri\*Factu real, 2026-05-20): `tenant_aeat_credentials` cifrado AES-GCM + upload UI de PKCS#12 en `/settings/billing/verifactu` + `VerifactuXmlBuilder` conforme al XSD AEAT + `RealAeatClient` con mTLS via `https.Agent` + cola BullMQ con retry exponencial + `POST /billing/invoices/:id/resend-aeat` + `<VerifactuBadge>` en facturas.
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
