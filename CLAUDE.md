# CLAUDE.md

Este archivo proporciona contexto persistente a Claude Code para este proyecto. Léelo siempre al inicio de cada sesión.

## Resumen del proyecto

**Nombre:** StorageOS (provisional)
**Tipo:** SaaS multi-tenant para la gestión integral de locales de self-storage.
**Cliente objetivo:** empresas propietarias de uno o varios locales de trasteros que necesitan gestionar trasteros, contratos, inquilinos, facturación, accesos y operativa diaria.

### Jerarquía de usuarios

1. **Super Admin** (nosotros): gestiona la plataforma y los tenants.
2. **Tenant** (empresa cliente): tiene N facilities (locales físicos) y varios usuarios internos con roles (owner, manager, staff, readonly).
3. **Customer** (inquilino final): alquila trasteros; opcionalmente tiene acceso a un portal propio.

## Stack tecnológico

### Backend

- **Node.js 20 LTS + NestJS** (TypeScript estricto)
- **Prisma ORM** sobre PostgreSQL 16
- **Redis** para caché, sesiones y colas
- **BullMQ** para tareas en background (facturación recurrente, emails, generación de PDFs)
- **Zod / class-validator** para validación
- **Passport + JWT** (access + refresh tokens) para autenticación, con 2FA TOTP

### Frontend

- **Next.js 15 (App Router) + React 19 + TypeScript**
- **Tailwind CSS + shadcn/ui**
- **TanStack Query** para data fetching y caché
- **Zustand** para estado global ligero
- **react-konva** para el editor visual de planos
- **Recharts** para dashboards
- **react-hook-form + Zod** para formularios

### Infraestructura

- **Docker + docker-compose** para todos los servicios
- **Despliegue**: VPS con Portainer y Nginx Proxy Manager (SSL vía Let's Encrypt)
- **Almacenamiento de archivos**: MinIO (S3-compatible, autohospedado)
- **Email transaccional**: Resend o Brevo (NO autohospedar SMTP)
- **Pagos**: Stripe (tarjeta) + GoCardless (SEPA); preparar abstracción para añadir Redsys
- **Observabilidad**: Sentry (errores), Uptime Kuma (uptime), Loki + Grafana o Better Stack (logs)

### Estructura del repositorio (monorepo)

Usamos **pnpm workspaces + Turborepo**. El estado actual es:

```
storageos/
├── apps/
│   ├── api/           # Backend NestJS (existente)
│   └── web/           # Frontend Next.js (existente; aloja panel tenant, portal y admin como rutas hasta que se separen)
├── packages/
│   ├── database/      # Prisma schema + cliente + migraciones + seed + tests Vitest
│   ├── shared/        # Schemas Zod + tipos compartidos (auth, users, invitations, 2fa, ...)
│   └── ui/            # Componentes UI compartidos (placeholder, shadcn vive en apps/web/src/components/ui/)
├── docker-compose.yml    # Servicios dev: postgres, redis, minio, mailpit, createbuckets
├── docker-compose.prod.yml  # Placeholder (Fase 8)
├── docs/              # ARCHITECTURE, DATA_MODEL, ROADMAP, API, DEPLOYMENT
├── CLAUDE.md          # Este archivo
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json
```

Los apps separados `portal/` (inquilino final) y `admin/` (super admin) están planificados pero todavía conviven como rutas dentro de `apps/web` hasta que el alcance lo justifique. Los configs compartidos (eslint, tsconfig, tailwind) viven en cada paquete y en la raíz; cuando crezcan se extraerán a `packages/config`.

## Multi-tenancy

- Estrategia: **shared database, shared schema con `tenant_id`** en todas las tablas.
- Refuerzo de aislamiento: **Row-Level Security (RLS) de PostgreSQL**.
- En el backend, todo request autenticado debe inyectar `tenant_id` en el contexto vía un guard/middleware. Las consultas Prisma DEBEN filtrar siempre por `tenant_id` (usar una extensión Prisma o un repositorio base).
- NUNCA exponer endpoints que devuelvan datos sin filtrar por tenant.

## Convenciones de código

- **TypeScript estricto** (`strict: true`, `noUncheckedIndexedAccess: true`).
- Imports absolutos con alias (`@/`, `@api/`, `@shared/`).
- Naming:
  - Tablas y columnas en **snake_case** (Postgres).
  - Modelos Prisma y propiedades TypeScript en **camelCase** (Prisma hace el mapping con `@map`).
  - Componentes React en **PascalCase**.
  - Hooks en **camelCase** con prefijo `use`.
- DTOs separados por capa: `CreateXxxDto`, `UpdateXxxDto`, `XxxResponseDto`.
- Validación con **Zod en ambos lados**; los schemas viven en `packages/shared` y se reutilizan en el backend vía `nestjs-zod` (`createZodDto`) y en el frontend vía `@hookform/resolvers/zod`. No usamos class-validator.
- Errores: usar excepciones de NestJS (`BadRequestException`, etc.) con mensajes traducibles.
- Tests: Jest para unit, Supertest para e2e backend, Playwright para e2e frontend.
- Commits: **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`...).
- Branches: trabajamos sobre `main` hasta tener un entorno de staging. Cuando lo montemos, se creará `develop`. Para cambios sustanciales se usan ramas `feat/...` o `fix/...`.

## Seguridad

- **Passwords** hasheadas con argon2id (`@node-rs/argon2`).
- **JWT** access HS256 de 15 min + **refresh opaco** `<tenantId>.<sessionId>.<secret>` en cookie httpOnly/secure/sameSite. Rotación + detección de reuso paranoid (un refresh ya rotado revoca todas las sesiones del user).
- **2FA TOTP** opt-in con secret cifrado AES-256-GCM en BD (`MASTER_ENCRYPTION_KEY`). Login con `pendingToken` corto firmado con secret independiente. 10 recovery codes hashed argon2id, single-use. La política de **forzar 2FA** para roles `owner`/`manager` se introducirá en Fase 8 como flag de tenant.
- **Rate limiting** con `@nestjs/throttler` (60/min default + presets por endpoint sensible).
- **CSP** estricta en frontend (pendiente afinar tras Fase 2).
- Sanitización de inputs de texto enriquecido (pendiente, llega cuando aparezcan editores ricos).
- **Audit logs** (`audit_logs`) para toda acción crítica.
- **RLS de Postgres** como segunda línea de defensa contra fugas entre tenants.
- **RGPD**: exportación y borrado de datos del inquilino bajo demanda (esquema definido, implementación llega en Fase 8).

## Internacionalización

- Locale por defecto: `es-ES` (España, euros, IVA 21%).
- Preparar i18n desde el inicio con `next-intl` y formato de fechas/monedas según el locale del tenant.
- Fechas siempre almacenadas en UTC, mostradas en la timezone del facility correspondiente.

## Documentación que debes leer y mantener actualizada

- `docs/ARCHITECTURE.md` — decisiones de arquitectura.
- `docs/DATA_MODEL.md` — modelo de datos completo.
- `docs/ROADMAP.md` — fases del proyecto y MVP.
- `docs/API.md` — convenciones de la API REST.
- `docs/DEPLOYMENT.md` — cómo desplegar en el VPS.

## Cómo trabajar conmigo (el desarrollador)

1. **Antes de escribir código nuevo**, comprueba si ya existe algo similar; reutiliza.
2. **Antes de cambios grandes**, propón un plan y espera mi confirmación.
3. **Después de cada feature**, actualiza la documentación relevante.
4. **Tests**: añade tests para lógica de negocio crítica (facturación, pricing, control de accesos, multi-tenancy).
5. **Migraciones Prisma**: nunca edites una migración ya aplicada; crea una nueva.
6. **Variables de entorno**: documenta cada nueva variable en `.env.example`.
7. **Idioma**: responde y comenta en **español**, código y nombres de variables en **inglés**.

## Estado actual

**Última actualización:** 2026-05-22 · Fase **4 completa** (facturación + pagos + dunning + RGPD + portal).

Lo construido hasta hoy: **Fase 1** (auth + multi-tenant), **Fase 2** (facilities + units + editor visual), **Fase 3** (customers + contracts + reservations EXCLUDE) y **Fase 4** (Verifactu ready con hash encadenado + Stripe gateway + BullMQ recurrente + dunning + RGPD + customer portal). Las fases 5–8 (accesos físicos, comunicaciones, operativa, super admin + despliegue) están **pendientes**. El detalle de cada sub-fase con sus checkboxes está en [`docs/ROADMAP.md`](docs/ROADMAP.md). Resumen de lo que existe ya funcionando:

### Backend (`apps/api`)

- **Auth completo**: register, login (con detección 2FA), refresh con rotación + detección de reuso paranoid, logout (single + global), `/auth/me`.
- **Verificación de email** con tokens single-use; bloquea login con 403 `email_not_verified` hasta verificar.
- **Password recovery** (`/auth/password/forgot`, `/auth/password/reset`); reset revoca todas las sesiones.
- **Gestión de usuarios** (`/users`, `/me`): invitaciones (única vía para crear users), edición, desactivación (soft delete), transferencia de propiedad atómica, `PATCH /me`, `POST /me/change-password` (revoca otras sesiones manteniendo la actual).
- **Invitaciones** (`/invitations`): crear, listar, revocar, reenviar (revoca la anterior con `revokedReason: 'replaced_by_resend'`), aceptar público (verifica email automáticamente). Token opaco `<invitationId>.<secret>`, hash argon2id, single-use atómico, TTL 7 días.
- **2FA TOTP**: setup/verify/disable/regenerate; login con `pendingToken` corto y `/auth/2fa/challenge`. Secret cifrado AES-256-GCM con `MASTER_ENCRYPTION_KEY`. 10 recovery codes `XXXX-XXXX` hashed argon2id, single-use.
- **RolesGuard** global con orden Throttler → JwtAuth → Roles. Decorador `@Roles('owner', 'manager')`.
- **Throttle**: 60/min default, 5/min login y 2FA challenge/disable, 3/h register y forgot-password, 30/min refresh.
- **Audit logs**: cada acción crítica queda en `audit_logs` (auth.register/login/refresh/logout, user.invited/updated/deactivated/ownership_transferred/password_changed, auth.2fa.enabled/disabled/challenge.success/failed/recovery_codes_regenerated/recovery_code_used).
- **Multi-tenancy**: 2 conexiones Postgres — `storageos_app` (RLS, usada por todo el día a día con `PrismaService.withTenant`) y `storageos` (admin, bypass RLS, solo para flujos sin tenant context: register, login lookup por slug, audit logs, invitaciones).
- **Email** vía nodemailer + plantillas React Email (verificación, password reset, invitación). En dev apunta a Mailpit.
- **Facilities + units + plano** (Fase 2): `facilities` con soft delete, `unit_types` por tenant, `units` con columnas generadas (`area_m2`, `volume_m3`), `unit_status_history` para trazabilidad. Endpoints `/facilities`, `/unit-types`, `/units` (con cursor pagination + filtros), `/units/:id/change-status` con transiciones validadas, `/units/:id/history`, `/floors/:id/plan-upload-url` (signed URL PUT a MinIO), `/floors/:id/units-layout` (coords del editor en `$transaction`), `/dashboard/occupancy` (agregación por facility + tipo).
- **MinIO** activo: `@aws-sdk/client-s3` + `getSignedUrl` PUT directo desde navegador (path `<tenantId>/<facilityId>/floors/<floorId>-<uuid>.<ext>`).
- **Customers + contratos + reservas** (Fase 3): `customers` con soft delete + búsqueda + KYC, `customer_documents` con upload directo MinIO (DNI/CIF/comprobante domicilio), `contracts` con state machine (draft→active→ending→ended/cancelled), `contract_events` para timeline inmutable, `reservations` con **EXCLUDE USING gist** sobre `tstzrange` (extensión `btree_gist`) que impide overbooking a nivel BD. Endpoints `/customers`, `/contracts`, `/reservations`, `/contracts/:id/{sign,request-end,end,cancel,change-price,generate-pdf,notes}`, `/reservations/:id/{confirm,cancel,convert-to-contract}`.
- **Pricing snapshot**: `contracts.priceMonthly` se congela al firmar; cambios via endpoint dedicado con motivo (registrado como `contract_events.price_changed`). Sincronización automática `units.status` desde el flujo de contratos (occupied/available).
- **PDF de contratos**: Puppeteer headless **síncrono** dentro del request. Dynamic import (`await import('puppeteer')`) por ser ESM-only, evitando que Jest CJS rompa. PDF a MinIO bucket `uploads` con `<tenantId>/contracts/<contractId>-<uuid>.pdf`. Mover a BullMQ en Fase 4.
- **Facturación + pagos** (Fase 4): `invoice_series` (numeración secuencial atómica por serie), `invoices` con Verifactu (hash SHA-256 encadenado entre facturas de la misma serie, QR AEAT como data URL, campos `aeat_*`) en state machine `draft → issued → paid/overdue/cancelled/refunded/partially_refunded`. `invoice_items` con snapshot del precio resuelto. PDFs con Puppeteer + QR embebido a MinIO bucket `invoices`. **Verifactu opera en `AEAT_MODE=stub`** en Fase 4: hashes + QR reales pero el envío AEAT es simulado; en Fase 8 cambia a `sandbox`/`production` sin tocar código.
- **Stripe gateway**: `PaymentGateway` interface + `StripeGateway` (Customer + SetupIntent + PaymentIntent + Refund + verifyWebhook con HMAC). Endpoints `POST /payments/invoices/:id/charge`, `POST /payment-methods/setup-intent`, webhook público `POST /webhooks/stripe` con raw body. Tokens de Stripe cifrados con `CryptoService` (AES-GCM, ADR-007).
- **BullMQ + Redis** activo en el mismo proceso NestJS (separar a `apps/worker` en Fase 8). Colas: `billing`, `dunning`, `payments`, `verifactu`, `email`. Cron diario `0 2 * * *` para `billing.generate-recurring` (crea drafts mensuales por contrato activo) + `0 6 * * *` para `dunning.daily` (marca overdue + programa acciones).
- **Dunning** calendario: +1 email_reminder, +7 email_reminder con recargo, +14 access_block (flag para Fase 5), +30 legal_notice manual. Cada acción se persiste en `dunning_actions` con `scheduled_for` / `executed_at`.
- **RGPD**: `data_subject_requests` con SLA 30 días + `consents`. Endpoint `POST /rgpd/customers/:id/anonymize` que sustituye datos personales por `*** ANONIMIZADO ***` y borra docs/payment_methods, **preservando invoices** por obligación fiscal (Verifactu + Ley 58/2003).
- **Customer portal mínimo**: magic link in-memory (no DB persist en MVP), endpoints públicos `POST /portal/login/{request,consume}` + `GET /portal/me/invoices` con JWT corto firmado con `JWT_2FA_PENDING_SECRET` y `purpose: 'portal'`.

### Frontend (`apps/web`)

- **Públicas**: landing, `/login` (con paso 2FA challenge integrado), `/register`, `/verify-email-sent`, `/verify-email/[token]`, `/forgot-password`, `/forgot-password-sent`, `/reset-password/[token]`, `/invite/[token]` (aceptar invitación → login automático), `/portal/login` + `/portal/consume` (cliente final con magic link → ver y pagar facturas).
- **Autenticadas**: `/dashboard` (con `<BillingMetricsCard>` MRR + pendiente + cobrado mes y `<OccupancyCard>` Recharts), `/facilities` + `/facilities/[id]` (tabs: trasteros, plantas + plano, tipos), `/units` + `/units/[id]`, `/customers` + `/customers/[id]` (tabs: contratos, reservas, documentos, datos + KYC), `/contracts` + `/contracts/new` (wizard 4 pasos) + `/contracts/[id]` (timeline + acciones + PDF), `/reservations`, `/invoices` + `/invoices/[id]` (state machine + PDF + QR Verifactu + acciones: issue/cancel/refund/mark-paid/charge), `/payments`, `/settings/users`, `/settings/profile`, `/settings/security`, `/settings/billing` (series de facturación).
- **Layout autenticado**: shadcn sidebar + header con FacilitySwitcher placeholder, UserMenu, ThemeToggle (light/dark/system), TrialBanner.
- **Auth client**: store Zustand (access token en memoria, refresh en cookie httpOnly), `apiFetch` con refresh transparente + deduplicación, hooks TanStack Query por módulo (`auth`, `users`, `invitations`, `two-factor`).
- **i18n** vía next-intl, locale `es-ES` único de momento (todas las claves en `messages/es.json`).

### Estado de tests

- **Database** (`packages/database`, Vitest): 11/11 — uuid_v7, RLS, seed.
- **API e2e** (`apps/api`, Jest + Supertest, en serie con `--runInBand`): **83/83 verdes**, repartidos en 16 suites.
- Helpers comunes en `apps/api/test/helpers/`: `registerVerifiedUser`, `waitForEmail`, `extractToken`, `cleanupTestTenants`, `generateTotpCode`. En tests el throttler aplica `skipIf: () => true`.

### Stack y dependencias instaladas

- **Backend**: NestJS 11, Prisma 6, PostgreSQL 16, nestjs-pino, nestjs-zod, passport-jwt, @nestjs/throttler, @node-rs/argon2, otpauth, nodemailer, React Email.
- **Frontend**: Next.js 15 (App Router) + React 19, Tailwind v3, shadcn/ui (button, input, label, form, card, dropdown-menu, sheet, sidebar, separator, skeleton, avatar, badge, alert, sonner, checkbox, tooltip, table, dialog, select, tabs), next-intl, next-themes, TanStack Query, Zustand, react-hook-form + @hookform/resolvers, qrcode.react.

### Notas operativas

- Branch único `main` (sin develop hasta que tengamos staging).
- Runtime Node 20.18.1 vía fnm (`.nvmrc`). Siempre `eval "$(fnm env --use-on-cd --version-file-strategy=recursive)"` antes de pnpm si se ejecuta desde scripts no-interactivos.
- `pnpm db:seed` crea un tenant demo `demo-storage` con owner `jota@storageos.local` / `Jota69` (configurable en `packages/database/.env`).
- Editor: el usuario usa **Google Antigravity IDE**, no VSCode. No generar config `.vscode/`.
- **Git lo hace el usuario a mano**. No hacer commit / push / branch automático ni configurar Husky / pre-commit hooks sin pedir antes.

### Próximo paso

**Fase 2** — Facilities, unit_types, units y editor visual de planos con react-konva. Ver `docs/ROADMAP.md` para el detalle.
