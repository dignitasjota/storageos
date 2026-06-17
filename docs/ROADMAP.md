# ROADMAP

Plan de desarrollo por fases. El objetivo es llegar a un MVP funcional con el menor scope posible, y luego iterar.

## Fase 0 — Setup (1-2 días)

- [x] Inicializar monorepo con pnpm workspaces + Turborepo
- [x] Configurar TypeScript estricto, ESLint, Prettier (Husky + lint-staged pospuesto a Fase 1)
- [x] Esqueleto NestJS en `apps/api`
- [x] Esqueleto Next.js 15 en `apps/web` con Tailwind + shadcn/ui (init, sin componentes)
- [x] Paquete `packages/database` con Prisma inicializado (modelo `Tenant` mínimo y migración inicial)
- [x] `docker-compose.yml` para desarrollo: postgres, redis, minio, **mailpit** (en vez de mailhog), createbuckets
- [x] `docker-compose.prod.yml` (placeholder, se completa en Fase 8)
- [x] `.env.example` documentado (raíz + apps + packages/database)
- [x] README con instrucciones de instalación y arranque
- [x] CI básico (GitHub Actions): lint + typecheck + build (`.github/workflows/ci.yml`)

## Fase 1 — Fundamentos multi-tenant (MVP core, 1-2 semanas)

Subdividida en sub-fases 1A–1F para facilitar revisiones intermedias.

### 1A — Schema completo + RLS + seeds ✅

- [x] Schema Prisma: `tenants`, `users`, `subscription_plans`, `tenant_subscriptions`, `audit_logs` + enums (`TenantStatus`, `UserRole`, `SubscriptionStatus`)
- [x] Función SQL `uuid_generate_v7()` (UUID v7 timestamp-ordered)
- [x] Rol Postgres `storageos_app` restringido sin `BYPASSRLS`
- [x] Row-Level Security policies (`tenants`, `users`, `tenant_subscriptions`, `audit_logs`)
- [x] Prisma client con helper `withTenantContext` (`set_config('app.current_tenant')`)
- [x] Seed dev idempotente (3 planes + tenant demo + owner + audit logs); credenciales por env
- [x] Tests Vitest (11/11): uuid_v7, RLS, seed
- [x] Husky + lint-staged

### 1B — Auth backend ✅

- [x] Tabla `sessions` con RLS (refresh tokens opacos + rotacion + reuso paranoid)
- [x] Schemas Zod compartidos en `@storageos/shared/auth` (Register, Login + DTOs)
- [x] `PrismaService` (`storageos_app`, RLS) + `PrismaAdminService` (`storageos`, bypass)
- [x] AsyncLocalStorage para tenant context por request
- [x] `TokensService`: access JWT HS256 + refresh opaco argon2id
- [x] `SessionsService`: create, rotate (3 tx separadas), revoke, revokeAllForUser; deteccion de reuso paranoid
- [x] `AuthService` con 6 flujos: register, login, refresh, logout, logout-all, me
- [x] `AuthController` + `JwtStrategy` (passport-jwt) + `@Public()` + `@CurrentUser()` + `JwtAuthGuard` global
- [x] Throttler diferenciado: 5/min login, 3/h register, 30/min refresh, 60/min default
- [x] Audit logs: auth.register, login.success/failed, refresh, logout, logout_all
- [x] Tests unit (19/19) + e2e Supertest (29/29)
- [x] `docs/API.md` documentado

### 1C — Frontend publico y layout autenticado ✅

- [x] Paginas publicas: landing, `/login`, `/register` (route groups `(public)` y `(app)`)
- [x] Layout de panel autenticado con `shadcn/sidebar` oficial + header (FacilitySwitcher placeholder, UserMenu, ThemeToggle, TrialBanner)
- [x] Componentes UI base instalados (button, input, label, form, card, dropdown-menu, sheet, sidebar, separator, skeleton, avatar, badge, alert, sonner, checkbox, tooltip)
- [x] Auth client con TanStack Query: store Zustand (access en memoria), fetcher con refresh transparente + cola de requests, hooks (useMe, useLogin, useRegister, useLogout, useLogoutAll)
- [x] `AuthBootstrap` que recupera el access token desde la cookie al cargar `/dashboard`
- [x] `middleware.ts` que redirige rutas autenticadas a `/login?next=...` sin cookie
- [x] react-hook-form + `zodResolver` con los schemas compartidos en `@storageos/shared/auth`
- [x] next-intl (locale `es-ES`, sin prefijo de URL) + next-themes (light/dark/system)
- [x] Fuente Geist + paleta neutral con accent azul
- [x] Dashboard placeholder con datos reales de `/auth/me`

### 1D — Verificacion email + password recovery ✅

- [x] Tabla `email_verification_tokens` (RLS) + `password_reset_tokens` (RLS) + `users.email_verified_at`
- [x] EmailService con nodemailer (Mailpit en dev) + plantillas React Email (verificacion y reset)
- [x] Endpoints: `POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /auth/password/forgot`, `POST /auth/password/reset`
- [x] `register` no emite tokens; envia email de verificacion y devuelve `requiresEmailVerification: true`
- [x] Login bloqueado con 403 + `code: email_not_verified` hasta verificar
- [x] Reset de password revoca **todas** las sesiones del usuario
- [x] Filter de excepciones propaga el campo `code` para distinguir sub-tipos de 403
- [x] Tests e2e con Mailpit API (37/37 verdes)
- [x] Frontend: paginas `/verify-email-sent`, `/verify-email/[token]`, `/forgot-password`, `/forgot-password-sent`, `/reset-password/[token]`

### 1E — User management + invitaciones + audit logs ✅

- [x] Tabla `invitations` con RLS + indice unico parcial para invitaciones pendientes
- [x] Schemas Zod en `@storageos/shared/users` (Invite, UpdateUser, UpdateProfile, ChangePassword, AcceptInvitation)
- [x] `RolesGuard` con decorador `@Roles(...)` (orden global: Throttler → JwtAuth → Roles)
- [x] `InvitationTokensService` con tokens opacos `<invitationId>.<secret>` + hash argon2id + atomic single-use
- [x] `InvitationsService`: list/create/revoke/resend + accept publico (resend invalida el token anterior con `revokedReason: 'replaced_by_resend'`)
- [x] React Email template `invitation-email.tsx`
- [x] Endpoints admin `/invitations` (owner/manager) + publicos `/invitations/token/:token` y `/invitations/token/:token/accept`
- [x] `UsersService` con invariantes: solo invitaciones (sin POST /users directo), unico owner, transferencia explicita, manager no puede asignar manager
- [x] Endpoints `/users` (list/detail/update/deactivate/transfer-ownership) + `/me` (PATCH perfil, POST change-password)
- [x] Change-password revoca otras sesiones y mantiene la actual
- [x] Aceptar invitacion verifica email automaticamente
- [x] Audit logs ampliados: user.invited, user.invitation_revoked, user.invitation_resent, user.invitation_accepted, user.updated, user.deactivated, user.ownership_transferred, user.password_changed
- [x] Tests e2e (50/50 verdes) cubriendo invitations, users, /me
- [x] Frontend `/settings/users` (tabla + invitar/editar/desactivar/transferir/revocar/reenviar)
- [x] Frontend `/settings/profile` con tabs (datos personales + cambio de contrasena)
- [x] Frontend publico `/invite/[token]` (aceptar invitacion -> login automatico)
- [x] Componentes shadcn adicionales: table, dialog, select, tabs

### 1F — 2FA TOTP ✅

- [x] Migracion: `users.two_factor_pending_secret`, tabla `recovery_codes` con RLS
- [x] `CryptoService` AES-256-GCM (`MASTER_ENCRYPTION_KEY`) para cifrar el TOTP secret en BD
- [x] `TotpService` (otpauth, SHA1, 6 digitos, periodo 30s, ventana ±1)
- [x] `RecoveryCodesService`: 10 codigos `XXXX-XXXX`, hashed argon2id, single-use atomico
- [x] Endpoints autenticados: `POST /auth/2fa/setup`, `/verify`, `/disable`, `/recovery-codes/regenerate`, `GET /auth/2fa/status`
- [x] Login con challenge: `/auth/login` devuelve `{ requires2fa, pendingToken }` cuando 2FA esta activado; `POST /auth/2fa/challenge` emite la sesion real
- [x] `pendingToken` JWT corto con secret independiente (`JWT_2FA_PENDING_SECRET`, TTL 5 min, purpose `2fa_pending`)
- [x] Audit logs: `auth.2fa.enabled/disabled/challenge.success/failed/recovery_codes_regenerated/recovery_code_used`
- [x] Throttle 5/min en `/auth/2fa/challenge` y `/auth/2fa/disable`
- [x] Tests e2e (9/9 verdes) cubriendo setup/verify/login challenge/recovery single-use/regenerate/disable
- [x] Frontend `/settings/security` con setup (QR + secret manual), verify, recovery codes (copiar/descargar/regenerar), disable
- [x] Frontend `/login` con paso de challenge integrado (estado en memoria, TOTP o recovery code)
- [x] **Opt-in**. El gate "must_setup_2fa" para roles owner/manager se introducira en Fase 8 / seguridad como politica de tenant

## Fase 2 — Locales, trasteros y plano ✅

- [x] Schema: `facilities`, `facility_floors`, `unit_types`, `units`, `unit_status_history` + RLS + columnas generadas `area_m2`/`volume_m3`
- [x] `unit_types` por tenant (compartidos entre facilities), `floors` opcional con default automática
- [x] API CRUD para facilities (soft delete), unit_types, units (con cursor pagination + filtros)
- [x] `POST /units/:id/change-status` con `unit_status_history` + transiciones válidas (`occupied` reservado a contratos en Fase 3)
- [x] `GET /units/:id/history` para timeline del trastero
- [x] MinIO + `@aws-sdk/client-s3` con signed URLs PUT directos: `POST /floors/:id/plan-upload-url` + `PATCH /floors/:id/plan`
- [x] `PATCH /floors/:id/units-layout` para guardar coordenadas del editor visual en `$transaction`
- [x] `GET /dashboard/occupancy` agregado por facility + por unit_type
- [x] Audit logs ampliados: `facility.created/updated/deleted`, `unit_type.*`, `floor.*`, `unit.created/updated/deleted/status_changed`
- [x] Tests e2e (10 nuevos, 69/69 totales): facilities CRUD, unit_types duplicate/deactivate, units codigo único, change-status con transiciones, dashboard agregación, plan-upload-url
- [x] Bug fix crítico en helper de tests: `env-setup.ts` no overrideaba `DATABASE_URL` cuando `packages/database/.env` ya lo había cargado como admin → RLS quedaba bypass en tests
- [x] Frontend `<DataTable>` reutilizable sobre TanStack Table v8 + shadcn Table (sorting/filtering/pagination)
- [x] Frontend `/facilities` (lista + alta) y `/facilities/[id]` con tabs (Trasteros, Plantas y plano, Tipos)
- [x] Frontend `/units` listado global con filtros (facility, status, tipo)
- [x] Frontend `/units/[id]` con stats + historial de estados
- [x] Editor visual `<PlanEditor>` con react-konva: imagen de fondo, rectángulos drag + snap a grid, guardar layout
- [x] Dashboard `/dashboard` con `<OccupancyCard>` (donut Recharts) + agregación por facility
- [x] `<FacilitySwitcher>` real en AppHeader: persiste selección en Zustand + localStorage

## Fase 3 — Inquilinos, contratos y reservas ✅

- [x] Schema: `customers` (soft delete), `customer_documents`, `contracts` (state machine), `contract_events`, `reservations` + RLS
- [x] **EXCLUDE USING gist** sobre `tstzrange` para evitar overbooking en reservations a nivel BD (extensión `btree_gist` + columna generada `time_range`)
- [x] CRUD customers con búsqueda full-text + KYC toggle + soft delete
- [x] CustomerDocuments con signed URL PUT a MinIO (PDF/PNG/JPG/WebP, máx 10 MB, tipos `id_front`/`id_back`/`proof_of_address`/`other`)
- [x] CRUD contracts con número secuencial `CT-{year}-{NNNNN}` por tenant
- [x] **State machine** contracts: `draft → active → ending → ended` + `cancel`. Cambios disparan `contract_events` y sincronizan `unit.status`
- [x] **Pricing snapshot**: precio congelado al firmar; cambios via `POST /contracts/:id/change-price` con motivo
- [x] Reservations: `pending → confirmed → converted/cancelled/expired`; convert genera contrato `draft`
- [x] `PricingService` ligero (base − descuento). Pricing rules + promotions quedan para Fase 4
- [x] `ContractPdfService` con Puppeteer headless (síncrono); PDF a MinIO + `signedPdfUrl`. Dynamic import por ESM/Jest
- [x] Audit logs: `customer.*`, `customer_document.*`, `contract.*`, `reservation.*`
- [x] Tests e2e (14 nuevos, 83/83 totales): customers, contracts state machine + invariantes, EXCLUDE constraint, convert reserva
- [x] Frontend `/customers` + `/customers/[id]` con tabs (contratos, reservas, documentos, datos)
- [x] Frontend `/contracts` + `/contracts/new` wizard 4 pasos + `/contracts/[id]` con timeline + PDF
- [x] Frontend `/reservations` con confirm/cancel/convert dialog
- [x] Plano interactivo: click sobre unit `available` muestra acciones (nuevo contrato / reservar / detalle)

## Fase 4 — Facturación y pagos ✅

- [x] Schema completo: `invoice_series`, `invoices` (con campos Verifactu: hash, previous*hash, qr_code_url, verifactu_mode, aeat*\*), `invoice_items`, `payments`, `payment_methods` (tokens cifrados AES-GCM), `dunning_actions`, `pricing_rules`, `promotions`, `data_subject_requests`, `consents` + RLS
- [x] **Verifactu ready** con `AEAT_MODE=stub` en Fase 4 (sandbox/production en Fase 8): hash SHA-256 encadenado entre facturas de la misma serie, QR AEAT generado con `qrcode`, estructura completa de envío preparada
- [x] **Numeración secuencial** atómica por serie con `prefix/year/00001`. Inmutable tras emitir
- [x] **State machine de invoices**: `draft → issued → paid/overdue/cancelled/refunded/partially_refunded` con transiciones validadas
- [x] **Invoicing custom + Stripe PaymentIntents** (no Stripe Billing managed). Patrón `PaymentGateway` interface + `StripeGateway`. Charges automáticos al cobrar invoice + webhook handler con verificación HMAC firma `Stripe-Signature`
- [x] **PaymentMethodsService** con Stripe SetupIntent + tokens cifrados con `CryptoService` (AES-256-GCM, ADR-007)
- [x] **`InvoicePdfService`** con Puppeteer + plantilla HTML inline + QR Verifactu embebido data-url + PDF a MinIO bucket `invoices`
- [x] **BullMQ + Redis** activado en mismo proceso NestJS (apps/worker separado para Fase 8). Colas: billing/dunning/payments/verifactu/email
- [x] **Cron diario `billing.generate-recurring`**: identifica contratos activos sin factura emitida para el periodo y crea drafts (no auto-issue: el admin revisa antes de emitir, para evitar errores costosos con hash Verifactu)
- [x] **PricingService extendido**: resuelve `pricing_rules` activas (scope unit/unit_type/facility/tenant + condiciones jsonb) + `promotions` con código. Snapshot del precio efectivo en cada `invoice_items.unit_price`
- [x] **DunningService** con state machine `issued → overdue` (cron diario) + calendario de acciones (+1 email recordatorio, +7 email con recargo, +14 access_block para Fase 5, +30 legal_notice manual)
- [x] **RgpdService**: exportación de datos del customer en JSON + anonimización irreversible (preserva invoices por obligación fiscal Verifactu, sustituye datos personales por `*** ANONIMIZADO ***`)
- [x] **Customer portal mínimo** con magic link in-memory: `POST /portal/login/{request,consume}`, lista de facturas + pago (UI placeholder, integración Stripe Elements en una iteración posterior)
- [x] Audit logs ampliados: `invoice.*`, `payment.*`, `payment_method.*`, `dunning.*.executed`, `rgpd.*`, `invoice_series.*`
- [x] Tests e2e (7 nuevos: invoice state machine, hash encadenado, mark-paid parcial/total, refund, series unique, portal magic link)
- [x] Frontend `/invoices` + `/invoices/[id]` con timeline, acciones según estado, PDF generate/download, visor QR Verifactu
- [x] Frontend `/payments` listado global
- [x] Frontend `/settings/billing` con CRUD de series de facturación
- [x] Frontend público `/portal/login` + `/portal/consume` con lista de facturas del cliente
- [x] Dashboard con `<BillingMetricsCard>`: MRR, pendiente de cobro, vencidas, cobrado este mes

## Fase 5 — Comunicaciones y CRM básico ✅

- [x] Schema: `leads`, `communications` (outbox), `message_templates`, `automation_rules`, `automation_runs` + RLS
- [x] `EmailProvider` abstracto (`smtp` para Mailpit en dev, `resend` para producción) seleccionado por env `EMAIL_PROVIDER`
- [x] Templating engine Handlebars con whitelist de variables por trigger (defensa contra fugas)
- [x] Plantillas built-in (welcome, contract_signed, contract_ending_soon, invoice_issued, invoice_overdue, reservation_confirmed, lead_thanks) seedables vía `MessageTemplatesService.seedBuiltins(tenantId)`
- [x] `CommunicationsService` con outbox pattern: persistencia BD antes de encolar, BullMQ con backoff exponencial, estados pending → processing → sent/failed, retry manual
- [x] `WhatsAppProvider` abstracto + stub (Fase 5: log only, sin envío real). Listo para WABA en Fase 8.
- [x] Endpoints `/message-templates` (CRUD + preview), `/communications` (list + send + retry), `/automations` (CRUD)
- [x] Motor de automatizaciones con `EventEmitter2`: triggers `customer_created`, `contract_signed`, `contract_ending_soon`, `contract_ended`, `invoice_issued`, `invoice_overdue`, `invoice_paid`, `reservation_confirmed`, `lead_created`. Reglas filtran por trigger + isActive y encolan job.
- [x] Emisión de eventos de dominio desde `ContractsService.sign`, `CustomersService.create`, `LeadsService.create*` (más triggers se irán añadiendo según necesidad)
- [x] `LeadsService` con state machine `new → contacted → qualified → won|lost` + conversion atomic a customer (+ opcional reservation)
- [x] Frontend `/leads` kanban con drag-and-drop nativo HTML5, `/communications`, `/message-templates`, `/automations`
- [x] Widget público `/widget/[slug]` (iframe-friendly): Next.js layout sin auth, middleware CSP `frame-ancestors *` + `X-Frame-Options: ALLOWALL`, honeypot anti-bot, throttle 5/min/IP en `POST /public/widget/:slug/leads`
- [x] `/settings/widget` con URL pública + snippet de embed + vista previa

## Fase 6 — Operativa y reporting ✅

- [x] Schema: `tasks`, `task_comments`, `incidents`, `incident_comments`, `products`, `product_stock`, `product_sales`, `product_sale_items`, `report_runs` + RLS para todas
- [x] **Tasks** (`/tasks`): trabajo planificado con state machine `open → in_progress → done | cancelled` (con rollbacks limitados), priority `low|normal|high|urgent`, asignación a user del tenant, due date, comentarios en tabla separada
- [x] **Incidents** (`/incidents`): problemas reportados con state machine `reported → investigating → resolved|dismissed`, severity `low|medium|high|critical`, vínculos a unit/customer/contract, comentarios. Emite `domain.incident_created` con `severity ≥ high` para automations
- [x] **Products + ventas accesorios**: catálogo por tenant (`/products`), stock por facility con bloqueo de overselling, `ProductSalesService` que crea factura Verifactu inline reusando `InvoicesService.create + issue` cuando hay customer
- [x] **Analytics** (`/analytics`): 4 KPIs en endpoints separados
  - Occupancy física y económica con MRR actual vs potencial
  - Churn mensual con cohort por mes de inicio
  - Aging buckets (0-30/30-60/60-90/+90) sobre facturas pendientes
  - Leads funnel (new/contacted/qualified/won/lost) con tasas de conversión y breakdown por source
- [x] **Reports** (`/reports`): Registry de `ReportGenerator` (invoices_period, contracts_active, aging_at_date). PDF con Puppeteer + Excel con exceljs server-side. Cola BullMQ `reports` con worker async, tabla `report_runs` con polling. Subida a MinIO bucket `storageos-reports` con TTL 7 días
- [x] Frontend: `/tasks`, `/incidents`, `/products`, `/analytics`, `/reports` + sidebar items

## Fase 7 — Control de accesos físicos ✅

- [x] Schema: `access_credentials`, `access_devices`, `access_logs` + RLS
- [x] **Credenciales** con métodos `pin` / `qr` / `rfid`, state machine `pending → active → suspended ⇄ active → revoked` (+ `expired` via fecha). PIN/QR-token hashed con argon2id; revelación solo al crear/rotar. RFID UID en claro.
- [x] **Devices** (`AccessDevice`) con API key (argon2id) para autenticación HTTP, opcional `mqttTopic`. Endpoint `/access/devices/:id/ping` para test de conectividad.
- [x] **`LockProvider` abstracto** + `StubLockProvider` (dev/test) + `MqttLockProvider` (publica comandos `<prefix>/<tenantId>/<topic>/open` en broker MQTT). Selector via env `LOCK_PROVIDER=stub|mqtt`.
- [x] **`/access/verify`** sin auth de user, autenticado por header `X-Device-Key`. Verifica credencial activa contra device, valida facility/unit/horario, registra en `access_logs` (allowed/denied\_\*/error), invoca `LockProvider.open` si allowed.
- [x] **Audit trail completo**: cada intento (exitoso, denegado, error) queda en `access_logs` con device + credential + customer + método + result + attemptedValue (sanitizado).
- [x] **Frontend** `/access` con tabs `credentials`/`devices`/`logs`. Crear/rotar credencial muestra `revealedSecret` UNA SOLA VEZ con CTA copy. Devices con regenerate API key + ping. Logs con filtros + PIN enmascarado.
- [x] **Dunning gate access_block**: hook desde `DunningProcessor` cuando `action_type='access_block'` invoca `CredentialsService.suspend(customerId)`. Cerrado en Fase 8 (`DunningService.executeAction('access_block')` → `AccessIntegrationsService.suspendForDunning`).

## Fase 8 — Super Admin, facturación SaaS y despliegue ✅

- [x] Schema `super_admins`, `support_tickets`, `support_ticket_messages`, `impersonation_logs` + RLS para tickets/messages
- [x] **Panel super admin** (auth separada con JWT purpose='superadmin' + AdminGuard): `/admin/tenants` (list/suspend/reactivate/extend-trial/impersonate), `/admin/metrics`, `/admin/support/tickets` (vista global)
- [x] **Impersonation** con audit en `impersonation_logs` (super admin abre JWT con `sub` random + `tenantId` + `superAdminId` claim + TTL 1h)
- [x] **Soporte de tickets**: tenant crea/lista en `/support/tickets`, admin gestiona en `/admin/support/tickets`. State machine + mensajes con flag `isInternal` (notas privadas solo visibles para admin)
- [x] **Stripe Billing** SaaS (distinto del gateway de Fase 4): extensión schema con `stripe_customer_id`, `stripe_subscription_id @unique`, `cancel_at_period_end`, `stripe_price_id`. `BillingSaasService` con Stripe Checkout (`mode='subscription'`) + Customer Portal. Webhooks para `customer.subscription.{created,updated,deleted}` y `invoice.payment_succeeded/failed`. Stripe SDK 22 (`current_period_*` ahora en `items.data[0]`).
- [x] **Despliegue VPS**: `docker-compose.prod.yml` (postgres + redis + minio + api + web + migrate one-shot), Dockerfiles multi-stage para api (Chromium del sistema) y web (`output: 'standalone'`). `docs/DEPLOYMENT.md` paso a paso. Scripts `backup.sh` (pg_dump cifrado GPG + mc mirror MinIO a Backblaze B2) y `restore.sh`.
- [x] **Integraciones aplazadas rescatadas**:
  - Listener `domain.contract_signed` → `AccessIntegrationsService.onContractSigned` emite PIN + envía email `access_credential_issued_email`
  - Dunning gate: `DunningService.executeAction(access_block)` invoca `AccessIntegrationsService.suspendForDunning(customerId)`. Listener `domain.invoice_paid` reactiva credenciales suspendidas por dunning (`onlyIfReasonStartsWith: 'dunning:'`)
- [x] Frontend completo: `/admin/{login,metrics,tenants,tenants/[id],support,support/[id]}`, `/(app)/support/{,[id]}`, `/(app)/settings/saas-billing`

## Fase 9 — Hardening pre-MVP ✅ (cierre 2026-05-20)

Bloque de cinco bloqueantes anotados al cerrar Fase 8 (super admin sin 2FA, sesion del super admin en localStorage, Verifactu acoplado al stub, ausencia de seed CLI para el super admin, Resend sin instrucciones de produccion). Se cierran en sub-bloques 9A.1 a 9A.8 sin tocar funcionalidad de negocio: solo seguridad y separacion de responsabilidades.

- [x] **9A.1 — Seed CLI super admin** (`packages/database/prisma/seed-superadmin.ts`): CLI idempotente con flags `--email --password --name --role [superadmin|support] --reset-password`. Sin `--reset-password` preserva el password si el admin ya existe; con la flag lo rota.
- [x] **9A.2 — Schema + migracion 2FA + sessions**: nuevas tablas `super_admin_sessions` (refresh `<sessionId>.<secret>` hashed argon2id, rotacion, `revoked_at/revoked_reason/replaced_by_session_id`) y `super_admin_recovery_codes` (codigos hashed argon2id, `used_at`). En `super_admins` se anaden `two_factor_secret`, `two_factor_pending_secret`, `two_factor_enabled`, `two_factor_enrolled_at`.
- [x] **9A.3 — `SuperAdminTwoFactorService` + 9 endpoints**: `GET /admin/auth/2fa/status`, `POST /admin/auth/2fa/{setup,verify,disable,recovery-codes/regenerate,challenge}` + login en dos pasos (cuando 2FA esta activo `/admin/auth/login` devuelve `{requires2fa, pendingToken}` y NO emite cookie). Secret TOTP cifrado AES-256-GCM con `MASTER_ENCRYPTION_KEY`. `pendingToken` JWT con secret `JWT_2FA_PENDING_SECRET` y `purpose='superadmin-2fa-pending'`. Reusa `TotpService` ya existente para tenants (un solo motor TOTP en el codigo).
- [x] **9A.4 — Refresh cookie httpOnly + paranoid reuse**: `super_admin_refresh` con `httpOnly`, `secure` (segun `COOKIE_SECURE`), `sameSite=strict`, `path=/admin`. `POST /admin/auth/refresh` rota la cookie en cada llamada; el reuso de un refresh ya rotado/expirado revoca TODAS las sesiones del admin. `POST /admin/auth/logout` revoca la sesion actual; `POST /admin/auth/logout-all` todas. TTL configurable via `SUPER_ADMIN_REFRESH_TTL_SECONDS` (default 7d).
- [x] **9A.5 — `AeatClient` abstracto + Stub + Real skeleton**: `apps/api/src/modules/billing/aeat-client/` con `AeatClient` abstract + `StubAeatClient` (devuelve `{ok:true, mode:'stub'}`) + `RealAeatClient` skeleton (lanza `not_implemented` hasta certificacion AEAT). Factory en `BillingModule` selecciona implementacion segun `AEAT_MODE=stub|sandbox|production`. Cambio a sandbox/production no toca codigo de negocio.
- [x] **9A.6 — Frontend admin 2FA**: `/admin/login` con paso `requires2fa` que muestra input de codigo TOTP/recovery + envia `POST /admin/auth/2fa/challenge`. Nueva ruta `/admin/security` con QR de setup, verify, disable (pide password) y regenerate de recovery codes. Cliente admin (`lib/admin/api.ts`) usa refresh transparente cookie-based + store Zustand para el access JWT en memoria.
- [x] **9A.7 — Resend en produccion**: documentacion en `docs/DEPLOYMENT.md` para activar `EMAIL_PROVIDER=resend`, alta de dominio en Resend, registros DKIM/SPF/DMARC, generacion de API key con scope minimo.
- [x] **9A.8 — Tests e2e + docs**:
  - `apps/api/test/super-admin-2fa.e2e-spec.ts`: login (con y sin 2FA), setup + verify + challenge, recovery codes single-use, refresh cookie + paranoid reuse, disable, regenerate.
  - `packages/database/tests/seed-superadmin.test.ts` (Vitest): seed idempotente + `--reset-password` + `--role`.
  - Actualizacion de `docs/ROADMAP.md`, `CLAUDE.md`, `README.md`.

**MVP COMPLETO Y LISTO PARA VENDER.** Tras Fase 9 quedan cerrados los cinco bloqueantes operativos detectados al cierre de Fase 8.

## Fase 10 — Veri\*Factu real ✅ (cierre 2026-05-20)

Cliente AEAT real para Veri*Factu (RD 1007/2023, vigente desde 2026-07-01). Sin Veri*Factu real las facturas no son legalmente válidas a partir de esa fecha, por lo que esta fase es la última pieza bloqueante antes de cobrar a un cliente español.

- [x] **10A.1 — Schema `tenant_aeat_credentials` + cifrado cert**: tabla con `cert_p12_encrypted` (Bytes), `cert_password_encrypted`, metadata (CN, NIF, issuer, valid_from, valid_to, environment), RLS por tenant. `TenantAeatCredentialsService` parsea PKCS#12 con `node-forge`, valida NIF + vigencia, cifra con `CryptoService` (AES-256-GCM). Endpoints `POST/GET/DELETE /billing/aeat-credentials/me` con multipart (límite 50KB). 9/9 tests e2e.
- [x] **10A.2 — XML builder Veri\*Factu `RegistroAlta`**: `VerifactuXmlBuilder.buildRegistroAlta(args)` conforme al XSD oficial. SOAP envelope completo con `Cabecera/ObligadoEmision`, `RegistroAlta` (IDFactura, NIFs, Desglose con IVA, Encadenamiento con `PrimerRegistro` o `RegistroAnterior`, `SistemaInformatico` configurable via env, `TipoHuella=01` + `Huella` SHA-256 mayúsculas). Helpers `formatSpanishDate` (DD-MM-YYYY), `formatTimestampWithMadridTimezone` (CET/CEST automático), `escapeXml`. 9/9 tests unit.
- [x] **10A.3 — Cliente HTTP real con mTLS**: `RealAeatClient.sendInvoice` carga cert del tenant, extrae PEM (cert + intermedios + privateKey), construye XML, POST a `AEAT_SANDBOX_ENDPOINT`/`AEAT_PRODUCTION_ENDPOINT` con `https.Agent` mTLS. Parseo SOAP con regex tolerante a namespaces (`<EstadoRegistro>`, `<CSV>`, `<CodigoErrorRegistro>`, `<DescripcionErrorRegistro>`, `<faultstring>`). Mapeo a `SendInvoiceResult`. 7/7 tests unit con `nock`.
- [x] **10A.4 — Cola BullMQ `verifactu` + retry**: `VerifactuProcessor` (concurrency 2, job `send-to-aeat`). `InvoicesService.issue` encola con `attempts: 3, backoff: exponential 60s, removeOnFail: false`. Worker reintenta solo si `result.status='error'` (técnico); `rejected` no reintenta (decisión firme AEAT). `VerifactuService.sendToAeat` devuelve `SendInvoiceResult | null` para señalizar al worker. `POST /billing/invoices/:id/resend-aeat` resetea `aeat_*` y reencola. 8/8 tests e2e.
- [x] **10A.5 — UI tenant cert + estado factura**: `/settings/billing/verifactu` con upload de PKCS#12 + password + environment, estado del cert (CN, NIF, issuer, valid_to con banner amarillo a 30 días / rojo si vencido), revoke con motivo. `<VerifactuBadge>` en `/invoices/[id]` con color por status (gris pending, verde accepted, amarillo warnings, rojo rejected/error), tooltip con `aeatSentAt` + mensaje, botón "Reenviar a AEAT" si `aeatStatus in (null, 'error', 'rejected')`, modal "Ver respuesta AEAT" con `aeatResponse` raw para diagnóstico. Sidebar item con role-gating `owner|manager`.
- [x] **10A.6 — Config AEAT_MODE + docs producción**: env `AEAT_SANDBOX_ENDPOINT`, `AEAT_PRODUCTION_ENDPOINT`, `AEAT_TIMEOUT_MS`, `AEAT_SISTEMA_NIF`, `AEAT_SISTEMA_NOMBRE`, `AEAT_SISTEMA_VERSION`, `AEAT_SISTEMA_INSTALACION`. Sección "11. Activar Veri\*Factu en producción" en `docs/DEPLOYMENT.md` (pre-requisitos del cert, upload UI, env vars, verificación, monitoreo Grafana/Loki, reenvío manual, incidencias conocidas). Diagrama de flujo + tabla de modos en `docs/ARCHITECTURE.md`.
- [x] **10A.7 — Tests e2e + ADR + cierre**: ADR `docs/adr/008-verifactu-real-client.md` (Veri\*Factu vs SII, cert por tenant vs presentador, mTLS sin XAdES, retry policy, alternativas rechazadas). Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, nota en vault Obsidian.

**Resultado**: el SaaS puede emitir facturas conformes a Veri\*Factu en sandbox AEAT. Activar producción requiere cambiar `AEAT_MODE=production` (sin tocar código) y que cada tenant haya subido su cert FNMT/Camerfirma/ANCERT desde `/settings/billing/verifactu`.

## Fase 11 — Compliance + observabilidad post-MVP ✅ (cierre 2026-05-20)

Cuatro brechas detectadas al cerrar Fase 10, todas hardening (no funcionalidad nueva). Se cierran en 5 sub-bloques 11A.1 a 11A.5. Detalle en ADR-044 (`docs/adr/044-compliance-observability-post-mvp.md`).

- [x] **11A.1 — `security_events` global**: nueva tabla **sin `tenant_id`** que persiste `login_failed_tenant_not_found`, `login_failed_email_not_found`, `login_failed_wrong_password` y `refresh_token_reuse` (eventos que no se pueden meter en `audit_logs` porque su `tenant_id` es `NOT NULL`). `SecurityEventsService` invocado desde `AuthService` y `SessionsService`. Endpoint `GET /admin/security-events` con filtros (`eventType`, `email`, `fromDate`, `toDate`) + cursor pagination. Página `/admin/security-events` en el panel super admin. Cron diario `0 3 * * *` que borra eventos > 90 días. 9/9 tests e2e.
- [x] **11A.2 — `tenant_aeat_credentials` histórico**: drop del UNIQUE en `tenant_id`; ahora la credencial activa se identifica por `revoked_at IS NULL`. `TenantAeatCredentialsService.upload` reescrito como `$transaction` (UPDATE actual con `revoked_reason='rotated'` + INSERT nueva). Nuevo `listHistory(tenantId)` ordenado por `uploaded_at DESC` + endpoint `GET /billing/aeat-credentials/history` (role `owner|manager`). UI colapsable en `/settings/billing/verifactu` con la lista histórica. 3/3 tests e2e.
- [x] **11A.3 — CSP `Report-Only` en panel autenticado**: cabeceras CSP en `next.config.mjs` (modo `Content-Security-Policy-Report-Only` durante 1 mes antes de enforcement). Directivas: `default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src 'self' https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; report-uri /api/csp-report;`. Endpoint `POST /api/csp-report` que loggea violaciones a Pino. **Excepción `/widget/:path*`**: el middleware mantiene `frame-ancestors *` + `X-Frame-Options: ALLOWALL` (iframe-friendly desde sites de tenants). Documentado en `docs/ARCHITECTURE.md`.
- [x] **11A.4 — Rectificativas Veri\*Factu R1-R5**: schema con enums `InvoiceType` (F1, F2, R1-R5) + `CorrectionMethod` (I/S) + columnas `invoice_type`, `rectifies_invoice_id` (FK self), `rectification_reason`, `correction_method`. `InvoicesService.rectify(originalId, args)` crea draft con items (pueden ser negativos). `VerifactuXmlBuilder` añade `<TipoRectificativa>I</TipoRectificativa>` + bloque `<FacturasRectificadas>` cuando `invoiceType` empieza por R. `RealAeatClient` carga la original via Prisma y la pasa al builder. Endpoint `POST /invoices/:id/rectify` (role `owner|manager`). UI: botón "Rectificar" + badge "Rectificativa" en `/invoices/[id]`. Tests: unit 12/12 (incluye 3 cases de rectificativas), e2e 7/7.
- [x] **11A.5 — ADR-044 + cierre**: `docs/adr/044-compliance-observability-post-mvp.md` con contexto + 4 sub-decisiones + alternativas rechazadas + trade-offs. Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

**Migraciones aplicadas**: `20260529000000_phase11a_security_events`, `20260529000100_phase11a_aeat_credentials_history`, `20260529000200_phase11a_invoice_rectifications`.

**Resultado**: el MVP cierra cuatro brechas detectadas al cierre de Fase 10. Verificación verde: `pnpm -F api typecheck && pnpm -F api lint && pnpm -F web typecheck && pnpm -F web lint && pnpm -F @storageos/database test`, e2e suites 11A.1 (9/9) + 11A.2 (3/3) + 11A.4 (7/7), unit `verifactu-xml-builder` 12/12.

## Fase 12 — Hardening operacional adicional ✅ (cierre 2026-05-20)

Bloque de cuatro brechas operacionales detectadas al planificar el despliegue al primer cliente. Todas son hardening, no funcionalidad nueva. Se cierran en 5 sub-bloques 12A.1 a 12A.5 sin tocar funcionalidad de negocio. Detalle en ADR-045 (`docs/adr/045-hardening-operacional-fase12.md`).

- [x] **12A.1 — Forzar 2FA owner/manager (flag tenant)**: nueva columna `require_two_factor_for_managers` en `tenants`. Cuando está activa, el login de un user `owner`/`manager` sin 2FA devuelve `{requires2faEnrolment, enrolmentToken}` sin emitir access; el `enrolmentToken` es un JWT corto firmado con `JWT_2FA_PENDING_SECRET` y `purpose='2fa-enrolment'` (TTL 10 min). Endpoints públicos `POST /auth/2fa/enrol-required/{setup,verify}` + endpoint admin `PATCH /settings/tenant/security` (role `owner`). Frontend: página pública `/security/enrolment/[token]` con 3 pasos (setup → verify → recovery codes) + banner persistente + `beforeunload`. Switch en `/settings/security` para que el owner active/desactive la política. 9/9 tests e2e.
- [x] **12A.2 — Alertas brute-force sobre `security_events`**: `SecurityAlertsService.scanAndAlert()` con `groupBy` sobre `security_events` filtrado por ventana + `HAVING count ≥ threshold`. Dedup in-memory por `${kind}:${identifier}`. Email vía `EmailProvider` al `SECURITY_ALERT_EMAIL`. Cron `*/5 * * * *` + endpoint manual `POST /admin/security-alerts/scan` (`AdminGuard`). Env nuevas: `SECURITY_BRUTE_FORCE_THRESHOLD=5`, `SECURITY_BRUTE_FORCE_WINDOW_MINUTES=15`, `SECURITY_ALERT_EMAIL`. 7/7 tests e2e.
- [x] **12A.3 — `super_admin_audit_logs` en BD**: tabla global nueva sin `tenant_id` y sin RLS. `SuperAdminAuditService.record()` defensivo (try/catch silencioso). Integrado en `SuperAdminAuthService.login` (success/failed), `SuperAdminTwoFactorService.{verify,disable,challenge,regenerateRecoveryCodes}` (2fa._), `SuperAdminTenantsService.{suspend,reactivate,extendTrial,impersonate}` (tenant._). Endpoint `GET /admin/audit-logs` con filtros (`action`, `superAdminId`, `targetTenantId`, `fromDate`, `toDate`) + cursor. Página `/admin/audit-logs` con tabla + filtros + item sidebar con icono `ScrollText`. 10/10 tests e2e.
- [x] **12A.4 — Smoke tests Playwright E2E**: instalado `@playwright/test` + `otpauth` en `apps/web/`. Config `apps/web/playwright.config.ts` con `fullyParallel: false, workers: 1` (BD compartida). 5 specs en `apps/web/e2e/`: `onboarding.spec.ts`, `billing.spec.ts`, `rectify.spec.ts`, `admin-2fa-impersonate.spec.ts`, `widget.spec.ts`. Helpers `apps/web/e2e/helpers/`: `mailpit.ts`, `totp.ts`. **No añadido a CI** todavía (queda pendiente).
- [x] **12A.5 — ADR-045 + cierre**: `docs/adr/045-hardening-operacional-fase12.md` con contexto + 4 sub-decisiones + alternativas rechazadas + trade-offs + lecciones aprendidas. Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

**Migraciones aplicadas**: `20260529010000_phase12a_force_2fa`, `20260529010100_phase12a_super_admin_audit_logs`.

**Resultado**: el MVP cierra cuatro brechas operacionales detectadas al planificar el despliegue. Verificación verde: typecheck/lint api+web, e2e suites force-2fa (9/9) + security-alerts (7/7) + super-admin-audit-logs (10/10). Total **26 nuevos tests**.

## Fase 13 — Robustez técnica pre-venta ✅ (cierre 2026-05-20)

Bloque de cuatro brechas técnicas pre-venta detectadas al planificar el despliegue al primer cliente real. Todas son hardening / robustez, no funcionalidad de negocio nueva. Se cierran en 5 sub-bloques 13A.1 a 13A.5 sin tocar funcionalidad de negocio. Detalle en ADR-046 (`docs/adr/046-robustez-tecnica-pre-venta-fase13.md`).

- [x] **13A.1 — Worker separado `apps/worker`**: nuevo paquete en el monorepo con `package.json` (name `worker`), Dockerfile multi-stage idéntico al de api (Chromium del sistema), `tsconfig.json` con `rootDir: ".."` + `jsx: react-jsx` para importar por path relativo módulos de `apps/api`. `worker.module.ts` importa Billing, Communications, Automations, Reports, Dunning, Access, SecurityEvents + infra. `main.ts` con `NestFactory.createApplicationContext` (no abre HTTP) + graceful shutdown SIGTERM/SIGINT. `docker-compose.prod.yml` añade servicio `worker`. **Tests del worker `worker-bootstrap.spec.ts` 2/2 verdes** (cierre del grafo DI + registro de las 6 colas BullMQ; antes `describe.skip`, activados al añadir `FilesModule` — ver nota en 14A.2).
- [x] **13A.2 — OpenAPI + API versioning `/v1/`**: `@nestjs/swagger ^11` + `swagger-ui-express ^5` instalados. Swagger UI en `/api/docs` gated por env `OPENAPI_ENABLED`. `app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })`. Legacy redirect `308 Permanent Redirect` aplicado via `app.use(legacyRedirectHandler)` ANTES de `enableVersioning` (la versión clase via `consumer.apply()` no se ejecuta antes del router con versioning activo). Excepciones `VERSION_NEUTRAL`: `/health`, `/webhooks/stripe`, `/public/widget/...`. Tests e2e existentes pasan via flag `rewriteLegacyToV1: true` en `test-app.factory.ts` (rewrite in-place; nuevos directos contra `/v1/...`). Spec nuevo `api-versioning.e2e-spec.ts` 4/4.
- [x] **13A.3 — F2 (factura simplificada) + rectificativas por sustitución**:
  - **F2** (RD 1619/2012 art. 4): `invoices.customer_id` ahora nullable. `CreateInvoiceSchema` añade `invoiceType: 'F1'|'F2'`, `customerId.optional()`, `simplifiedJustification`. Validación: F1 sin customer → 400 `customer_required`; F2 > 400€ sin justification → 400 `f2_amount_limit_exceeded`; F2 > 3000€ → 400 `f2_amount_hard_limit_exceeded`. XML AEAT: F2 sin recipient emite `<FacturaSinIdentifDestinatarioArt61d>S</...>`.
  - **Sustitución** (RD 1619/2012 art. 15): `RectifyInvoiceSchema` añade `correctionMethod: 'by_differences'|'by_substitution'`. XML emite `<TipoRectificativa>S</TipoRectificativa>` + bloque `<ImporteRectificacion>` con `BaseRectificada`/`CuotaRectificada`/`CuotaRecargoRectificado` (originales de la factura rectificada).
  - UI: dialog "Nueva factura" con F1/F2 selector + justification; modal "Rectificar" con radio "por diferencias"/"por sustitución".
  - Tests: unit `verifactu-xml-builder` 17/17 + e2e `invoice-f2.e2e-spec.ts` 8/8 + e2e `invoice-rectifications.e2e-spec.ts` 10/10 (incluye sustitución).
- [x] **13A.4 — CSP enforce + Playwright CI**:
  - CSP: header `Content-Security-Policy-Report-Only` → `Content-Security-Policy` (enforce). Directivas idénticas a Fase 11A.3. `/widget/:path*` conserva `frame-ancestors *` en middleware. Endpoint `/api/csp-report` sigue activo.
  - Workflow `.github/workflows/e2e.yml` nuevo (separado de `ci.yml` principal, **no bloquea merges**): services postgres+redis+mailpit, `pnpm db:migrate:deploy && db:seed`, `playwright install chromium --with-deps`, build API + web standalone, arranque API+web en background, `pnpm -F web test:e2e`, upload `playwright-report/` como artifact (retention 7 días). Mailpit `deleteAllMessages` al inicio de cada suite (mitigación flakiness).
- [x] **13A.5 — ADR-046 + cierre**: `docs/adr/046-robustez-tecnica-pre-venta-fase13.md` con contexto + 4 sub-decisiones + alternativas rechazadas + trade-offs + lecciones aprendidas. Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

**Migraciones aplicadas**: `20260529020000_phase13a_invoice_f2`.

**Resultado**: el MVP cierra cuatro brechas técnicas pre-venta. Verificación verde: typecheck/lint api+worker+web, build worker, e2e suites api-versioning (4/4) + invoice-f2 (8/8) + invoice-rectifications (10/10) + unit verifactu-xml-builder (17/17). Total **39 nuevos tests** (4 + 8 + 17 + 10).

## Fase 14 — Hardening final pre-deploy ✅ (cierre 2026-05-20)

Bloque de tres piezas que faltaban para que el SaaS sea production-ready, no solo "MVP cerrado". Todas son hardening operacional + habilitación de integraciones externas, no funcionalidad de negocio nueva. Se cierran en 4 sub-bloques 14A.1 a 14A.4. Detalle en ADR-047 (`docs/adr/047-hardening-final-pre-deploy-fase14.md`).

- [x] **14A.1 — Flag `ENABLE_WORKERS_IN_API`**: env var nueva (default `true`). En `apps/api/src/config/workers-enabled.ts` constante leída de `process.env` (no via `ConfigService` porque se consume en `@Module()` decorator). Cada Module condiciona Processors + Crons via `...(WORKERS_ENABLED_IN_API ? [...] : [])` en el array `providers`. En `apps/worker/src/main.ts` primera línea fuerza `process.env.ENABLE_WORKERS_IN_API='true'` (defense-in-depth). **Refactor**: services que combinaban `@Cron` + `@Processor` partidos en service base (lógica + cron) + wrapper `@Processor` (`BillingJobsService` + `BillingRecurringProcessor`, `DunningService` + `DunningProcessor`, etc.). `docker-compose.prod.yml` con `ENABLE_WORKERS_IN_API: 'false'` en servicio API. `docs/DEPLOYMENT.md` §12 nueva. **Test e2e `workers-flag.e2e-spec.ts` 3/3 verde (cierre 2026-06-01)**: antes `describe.skip` por un bug DI ("Nest can't resolve dependencies of the EventSubscribersLoader"); la causa era importar `Test` de `@nestjs/testing` a nivel top-level mientras `jest.isolateModulesAsync` cargaba copias frescas de `@nestjs/core`/`@nestjs/event-emitter` — el `ModuleRef` de la copia aislada no coincidía con el del injector externo. Fix: importar `Test` dentro del bloque aislado para que todo comparta el mismo registro de módulos.
- [x] **14A.2 — Tests worker con `ioredis-mock`**: `moduleNameMapper: { '^ioredis$': 'ioredis-mock' }` en `apps/worker/jest.config.js`. `jest.mock` factory no funciona en `setupFiles` (se evalúa antes que el TestRunner monte el module registry); `moduleNameMapper` es el único que funciona a nivel resolver. **Activados (cierre 2026-06-01)**: los tests del bootstrap pasan a verde (2/2) tras añadir `FilesModule` a `WorkerModule` — la única dep DI faltante era el provider global `FilesService` que `InvoicePdfService` inyecta en `BillingModule` (en el API lo aporta `AppModule` por ser `@Global()`); no hacían falta más providers que los del TODO original. La infra de mocking `ioredis-mock` no requirió cambios.
- [x] **14A.3 — API keys + webhooks salientes con HMAC**:
  - **API keys**: schema `api_keys` `(id, tenant_id, name, prefix, secret_hash, scopes JSONB, last_used_at, created_at, revoked_at)` con RLS. Token `sk_live_<tenantId>.<secret>` revealed-once; en BD `prefix` (12 chars) + `secret_hash` argon2id. `ApiKeysService.create/verify/list/revoke` + `ApiKeyGuard` (Bearer). Endpoints `/settings/api-keys`. **Scopes persistidos pero NO enforced en MVP** (informativos hasta Fase 15+). UI tab "Integraciones / API keys" en `/settings/integrations`. 6/6 e2e verde aislado.
  - **Webhooks salientes**: schemas `webhooks` `(tenant_id, url, secret_encrypted, events[], is_active, last_delivery_at)` + `webhook_deliveries` `(webhook_id, event, payload JSONB, status, http_status, error_message, attempt, delivered_at)`. Secret cifrado AES-256-GCM con `CryptoService`. `WebhooksService.dispatch(tenantId, event, payload)` busca webhooks activos donde `event = ANY(events)` y encola en cola BullMQ `webhooks`. `WebhooksProcessor` re-serializa el payload en cada attempt (JSONB de Postgres no preserva orden de claves) → calcula HMAC SHA-256 → POST con headers `X-Storageos-Signature: t=<ts>,v1=<hmac>`, `X-Storageos-Event`, `X-Storageos-Delivery`. Retry 3× exponencial 60s (`backoff: { type: 'exponential', delay: 60_000 }`). Listeners `domain.invoice_paid/issued/overdue`, `contract_signed`, `lead_created` mapeados a eventos públicos `invoice.paid/issued/overdue`, `contract.signed`, `lead.created`. UI tab "Integraciones / Webhooks" con CRUD + tabla últimos 50 deliveries con expand. 5/5 e2e verde aislado.
- [x] **14A.4 — ADR-047 + cierre**: `docs/adr/047-hardening-final-pre-deploy-fase14.md` con contexto + 3 sub-decisiones + alternativas rechazadas + trade-offs + lecciones aprendidas. Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

**Migraciones aplicadas**: `20260529030000_phase14a_api_keys_webhooks`.

**Resultado**: el MVP cierra tres piezas pendientes para deploy en producción. Verificación verde: `pnpm -F api typecheck && pnpm -F api lint && pnpm -F worker typecheck && pnpm -F web typecheck && pnpm -F web lint && pnpm -F worker build`, e2e suites api-keys (6/6) + webhooks (5/5). Total **11 nuevos tests** (6 + 5).

## Fase 15 — Cierre de TODOs y operabilidad ✅ (cierre 2026-05-21)

Bloque de tres TODOs operativos anotados al cerrar Fase 14 que bloqueaban el despliegue al primer cliente real: invoices `aeat_status='pending'` huérfanas sin polling, webhooks fallidos sin retry manual desde UI, API keys con scopes informativos pero no enforced. Todas son operabilidad / habilitación, no funcionalidad de negocio nueva. Se cierran en 4 sub-bloques 15A.1 a 15A.4. Detalle en ADR-048 (`docs/adr/048-cierre-todos-operabilidad-fase15.md`).

- [x] **15A.1 — AEAT `getStatus` polling + endpoint manual**: `RealAeatClient.getStatus(args)` implementado con XML SOAP `ConsultaFactuSistemaFacturacion` (AEAT espera filtro por NIF emisor + número + fecha, no por CSV). `VerifactuXmlBuilder.buildConsultaFactu(args)` genera el envelope con `Cabecera/ObligadoEmision` + `FiltroConsulta/PeriodoImpositivo` + `IDFactura/NumSerieFactura/FechaExpedicionFactura`. Parseo SOAP con regex tolerante a namespaces idéntico al de `sendInvoice`. `VerifactuService.refreshStatus(invoiceId, tenantId)` carga la invoice `pending`, llama `getStatus`, actualiza `aeat_status` + `aeat_csv` + `aeat_response`. `VerifactuStatusPollerCron` con `@Cron('*/15 * * * *')` busca invoices con `aeat_status='pending'` y `aeat_sent_at < now() - 5min` (skip recién enviadas), hasta 50 en batch (`take: 50`) ordenadas por `aeat_sent_at ASC`. Condicionado al spread `WORKERS_ENABLED_IN_API` (Fase 14A.1) — en producción corre en el worker. Endpoint `POST /v1/billing/invoices/:id/refresh-aeat-status` (role `owner|manager`) permite consulta manual. UI: botón "Consultar AEAT" en `<VerifactuBadge>` cuando status `pending` o `error`. Tests: `real-aeat-client.spec` ampliado a 10/10 (3 cases nuevos sobre `getStatus`) + `verifactu-xml-builder.spec` ampliado a 18/18 (1 case nuevo sobre `buildConsultaFactu`).
- [x] **15A.2 — Webhooks dashboard + retry manual**: `WebhooksService.retryDelivery(args)` resetea `attempts=0`, `status='pending'`, `error_message=null` ANTES de encolar (orden importa por race con el worker — si encolas primero, el worker puede leer `attempts=3` y dropear antes del UPDATE). Validaciones: `delivery_not_found` (404) si no existe, `delivery_not_retryable` (400) si `status !== 'failed'`. Endpoint `POST /v1/settings/webhooks/:webhookId/deliveries/:deliveryId/retry` (role `owner|manager`). Página nueva `/settings/webhooks/[id]` con tabla de deliveries paginada **cursor** (no offset — `webhook_deliveries` puede crecer a 100k+ filas) + filtros (`status`, `fromDate`, `toDate`) + dialog detalle con `payload` JSON, `signature`, `httpStatus`, `responseBody`, `errorMessage`. Botón "Reintentar" sólo cuando `status='failed'`. El tab "Webhooks" de `/settings/integrations` ahora tiene un botón "Ver deliveries" por webhook que lleva a `/settings/webhooks/[id]`. Tests `webhooks.e2e` ampliado a 10/10 (5 cases nuevos sobre dashboard + retry).
- [x] **15A.3 — API keys scopes enforced**: lista whitelist de **5 scopes** en `packages/shared/src/integrations/api-keys.schema.ts` (`invoices:read`, `invoices:write`, `contracts:read`, `customers:read`, `webhooks:trigger`). Decorador `@RequireScope(scope: string)` + metadata `REQUIRE_SCOPE_KEY`. `ApiKeyGuard` lee con `Reflector.getAllAndOverride(REQUIRE_SCOPE_KEY, [handler, class])`; si la API key no tiene el scope ni el wildcard `'*'`, lanza `ForbiddenException` con `code: 'insufficient_scope'` + `details: { requiredScope }` (HttpExceptionFilter solo propaga `code` + `details` al body — usar `details`, no top-level). `ApiKeysService.create` normaliza scopes: `[]` → `['*']` (backwards-compat con Fase 14A.3); los 5 públicos completos → `['*']` (atajo); scope desconocido → 400 `invalid_scope` con `details: { invalidScope }`. Endpoint `GET /v1/integrations/whoami` con `@RequireScope('invoices:read')` como ejemplo (primer endpoint público). UI multiselect de scopes (checkboxes) en dialog "Nueva API key" con hint "(sin selección = acceso total)". Tests `api-keys.e2e` ampliado a 12/12 (6 cases nuevos sobre scopes: create con scope inválido, create con whitelist completa → wildcard, whoami con scope correcto, whoami sin scope → 403, whoami con wildcard → ok, retrocompat con keys sin scopes).
- [x] **15A.4 — ADR-048 + cierre**: `docs/adr/048-cierre-todos-operabilidad-fase15.md` con contexto + 3 sub-decisiones + alternativas rechazadas + trade-offs + lecciones aprendidas. Actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

**Resultado**: el MVP cierra tres TODOs operativos. Verificación verde: `pnpm -F api typecheck && pnpm -F api lint && pnpm -F web typecheck && pnpm -F web lint`, tests unit `verifactu-xml-builder.spec` 18/18 + `real-aeat-client.spec` 10/10, e2e suites `webhooks.e2e` 10/10 + `api-keys.e2e` 12/12. **Total 32 tests verdes** (10 unit + 18 unit + 10 e2e + 12 e2e — ampliación de los existentes + nuevos cases sobre `getStatus`, retry manual y scopes enforced).

## Fase 16 — Cierre de TODOs residuales + RGPD tenant ✅ (cierre 2026-06-09)

Bloque de limpieza de los TODOs que quedaban en el código tras Fase 15: dos tests en `describe.skip`, el `email_reminder` del dunning sin conectar al outbox, un endpoint SaaS con guard incorrecto, el rate-limit sin traza en `security_events`, un comentario obsoleto y la anonimización RGPD del tenant sin implementar. Sin migraciones (los enums necesarios ya existían). No se crea ADR: son cierres de deuda, no decisiones de arquitectura nuevas.

- [x] **16A.1 — Tests del worker + flag activados**: `apps/worker/test/worker-bootstrap.spec.ts` (2/2) pasa de `describe.skip` a verde añadiendo `FilesModule` (provider global `FilesService` que `InvoicePdfService` inyecta en `BillingModule`) a `WorkerModule` — única dep DI faltante, no los `ContractsModule`/`CustomersModule` que sugería el TODO antiguo. `apps/api/test/workers-flag.e2e-spec.ts` (3/3) pasa de `describe.skip` a verde importando `Test` de `@nestjs/testing` DENTRO del bloque `jest.isolateModulesAsync` (el bug "Nest can't resolve EventSubscribersLoader" venía de mezclar el `@nestjs/core` externo con el `AppModule` reimportado en aislamiento → `ModuleRef` con identidad distinta).
- [x] **16A.2 — `email_reminder` del dunning conectado al outbox**: `DunningService.executeAction('email_reminder')` ahora encola el recordatorio vía `CommunicationsService.enqueue` (plantilla `invoice_overdue_email`, trigger `invoice_overdue` con su whitelist, `source='dunning.email_reminder'`). Carga importes + customer del invoice, calcula `amountPending` y `daysOverdue`. Si la factura no tiene customer/email (F2) loguea y marca `executed` con `emailEnqueued:false` sin romper la acción. Unit spec `dunning.service.spec.ts` 3/3.
- [x] **16A.3 — Fix de seguridad `AdminGuard` en planes SaaS**: los endpoints de gestión del catálogo de planes (`GET /subscription-plans/admin` + `POST/PATCH/DELETE`) pasan del apaño `@Roles('owner')` (cualquier owner de tenant) a `@Public() @UseGuards(AdminGuard)` (super admin). `BillingSaasModule` registra `AdminGuard` + `JwtModule.register({})` para resolver su `JwtService`. `GET /subscription-plans` público (pricing) intacto. Sin impacto en frontend (solo consumía el GET público).
- [x] **16A.4 — Rate-limit en `security_events` + comentario obsoleto**: nuevo `SecurityThrottlerGuard` (extiende `ThrottlerGuard`, registrado como primer `APP_GUARD` en vez del base) que, cuando el throttler corta un endpoint sensible de auth, mapea la ruta a `login_failed_throttled` / `register_throttled` / `password_reset_throttled` y llama `SecurityEventsService.record` antes de lanzar `ThrottlerException` (los enums ya existían). Corregido el comentario obsoleto de `RealAeatClient` que marcaba `getStatus` como "TODO post-MVP" (implementado en 15A.1).
- [x] **16A.5 — Anonimización RGPD del tenant (derecho al olvido)**: `AdminTenantsService.anonymize` (antes lanzaba `Error`) + endpoint `POST /admin/tenants/:id/anonymize` (`AdminGuard`, requiere `reason`). En una `$transaction`: anonimiza todos los customers (placeholders + soft delete, preservando invoices por obligación fiscal), borra docs/payment_methods, anonimiza el staff (`users`: email único irreversible por el `@@unique([tenantId,email])`, 2FA off, `passwordHash` = hash de secreto aleatorio, `isActive=false`), revoca sesiones y marca el tenant `cancelled`+`deletedAt`+borra `billingEmail`/`taxId`. Doble rastro en `audit_logs` + `super_admin_audit_logs`. UI: botón "Anonimizar (RGPD)" en `/admin/tenants/[id]` con dialog de confirmación fuerte (teclear el `slug` para habilitar) + motivo; redirige a `/admin/tenants` al completarse. Tipo `AnonymizeTenantResultDto` en `packages/shared`. Unit spec `admin-tenants.service.spec.ts` 2/2.

**Resultado**: el código queda sin TODOs de peso ni tests en `describe.skip`; el dunning envía de verdad los recordatorios de pago y el flujo RGPD a nivel tenant está completo de punta a punta. Verificación verde: `pnpm -F api typecheck && pnpm -F api lint && pnpm -F web typecheck && pnpm -F web lint && pnpm -F @storageos/shared build`, suite unit API 52/52 (incluye `dunning.service.spec` 3/3 + `admin-tenants.service.spec` 2/2) + worker 2/2 + e2e `workers-flag` 3/3. Pendiente residual menor: instrumentar `invitation_token_invalid` en `InvitationsService`; ampliar la anonimización RGPD a `leads`/`communications` si se requiere cobertura PII total.

## Fase 17 — Pagos SEPA + portal de cobro + hardening pre-deploy ✅ (cierre 2026-06-12)

Bloque construido tras Fase 16 al preparar el despliegue real: el medio de pago dominante en España (domiciliación SEPA), permitir que el inquilino pague desde su portal, automatizar el cobro al emitir, y blindar el flujo de pagos + la observabilidad antes de tocar dinero de verdad. Cierra también los dos opcionales que quedaban anotados en Fase 16 y un bug latente del historial de migraciones que rompía cualquier BD nueva.

- [x] **17A.1 — Webhooks Stripe idempotentes + fin del doble-conteo**: tabla global `processed_stripe_events` (sin `tenant_id`, sin RLS, PK = `event.id`). `StripeEventsService.markProcessed` inserta ANTES de procesar (duplicado → P2002 → descarte) y `release` borra si el handler falla (no comerse el retry de Stripe). Cleanup cron diario 04:00 a 30 días (gated `WORKERS_ENABLED_IN_API`). `PaymentsService.syncFromWebhook` idempotente: descarta status repetido o payment en estado terminal — antes cada cobro con éxito **doble-contaba** `amountPaid` (suma síncrona en `chargeInvoice` + suma del webhook). `charge.refunded` deja de ser log-only: `syncRefundFromWebhook` sincroniza por delta contra el `amount_refunded` acumulado de Stripe (idempotente por construcción) y propaga a la invoice capando en `total`. Unit specs `payments.service.spec` 9/9 + `stripe-events.service.spec` 4/4.
- [x] **17A.2 — SEPA Direct Debit vía Stripe (panel staff)**: cobro por domiciliación con el `StripeGateway` existente (`sepa_debit`), sin GoCardless. `ChargeParams.paymentMethodType` nuevo — el PaymentIntent declara `payment_method_types: [tipo]` (el default `['card']` hace fallar un cobro SEPA). `chargeInvoice` rechaza PMs no cobrables (`cash/bank_transfer/other` → 400 `payment_method_not_chargeable`). El registro de PMs deriva el `type` real del gateway, no del input. Los cobros SEPA quedan `processing` (liquidación 2-5 días); el webhook resuelve a `succeeded/failed`. R-transactions: `charge.dispute.created` → `syncDisputeFromWebhook` revierte el payment a `failed`, resta `amountPaid` y devuelve la invoice a `overdue/issued`. UI: pestaña **Pagos** en `/customers/[id]` con Stripe `<PaymentElement>` (tarjeta + IBAN con mandato). `DEPLOYMENT.md` §12B con IBANs de test.
- [x] **17A.3 — Self-service de IBAN + pago en el portal del inquilino**: el inquilino registra su propio PM y paga facturas desde el portal (mandato SEPA aceptado online por el pagador). Endpoints `@Public` con auth manual por JWT de portal (`requirePortalSession`): `GET /portal/me/payment-methods`, `POST .../setup-intent`, `POST .../payment-methods` (sin `customerId` ni `type` — salen del token y del gateway; PM siempre default), `POST /portal/me/invoices/:id/charge` (verifica propiedad → 404; cobra con `userId: null`). Throttle 5/min. UI: card "Método de pago" en `consume/page.tsx` con `<StripeSetupForm>` compartido + botón "Pagar" real. E2e `portal-payments.e2e-spec` 4/4.
- [x] **17A.4 — Auto-charge al emitir factura (opt-in por tenant)**: flag `tenants.auto_charge_on_issue` (default false) + `GET/PATCH /settings/tenant/billing` + card en `/settings/billing`. **`InvoicesService.issue()` ahora emite `domain.invoice_issued`** (estaba declarado con listeners — automations + webhook `invoice.issued` — pero nunca se emitía; este fix activa ambos). `AutoChargeService` (`@OnEvent`, siempre en el API) encola en la cola `payments`; `AutoChargeProcessor` (gated, corre en el worker) re-chequea flag + invoice cobrable + PM default y cobra con `userId: null`; cobro rechazado no lanza (entra el dunning). Unit `auto-charge.service.spec` 9/9 + e2e 2/2.
- [x] **17A.5 — Sentry + readiness probe**: `@sentry/nestjs` en API y worker via `instrument.ts` (primera línea de cada `main.ts`; sin `SENTRY_DSN` es no-op). API captura 5xx desde `HttpExceptionFilter`; worker captura unhandled rejections. Env `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`. Nuevo `GET /health/ready` (VERSION_NEUTRAL): `SELECT 1` a Postgres + `PING` a Redis; 503 con `details` si algo cae. Uptime Kuma debe apuntar a `/health/ready` (no a `/health`, que es solo liveness).
- [x] **17A.6 — Reparación del historial de migraciones**: las migraciones de Fases 11-14 tenían timestamps `202605200xxxxx` que ordenaban ANTES que `phase4_billing`/`phase10a` (cuyas tablas alteran), rompiendo cualquier BD nueva (shadow DB, CI, primer `migrate deploy` del VPS). Fix: 7 directorios renombrados a `202605290xxxxx` (orden relativo preservado), `migration_name` actualizado en `_prisma_migrations` dev, borradas 3 filas rolled-back. Verificado: **`migrate deploy` aplica las 40 migraciones limpias desde cero**. ⚠️ `migrate dev` siempre detectará un drift esperado que NUNCA hay que aceptar (columnas generadas `reservations.time_range` y `units.area_m2/volume_m3` que viven solo en SQL manual).
- [x] **17A.7 — Opcionales menores de Fase 16 cerrados**: (1) `invitation_token_invalid` instrumentado en `InvitationsService` (última traza de seguridad pendiente); (2) anonimización RGPD del tenant ampliada a `leads` y `communications` dentro de la misma `$transaction`; (3) **dinero sin floats**: helpers `common/money.ts` (aritmética en céntimos enteros) reemplazan los 11 epsilons `0.001` en `payments`/`invoices` — spec `money.spec`; (4) **heartbeat de workers**: `WorkersHeartbeatCron` escribe `workers:heartbeat` en Redis cada minuto (TTL 3 min); `GET /health/worker` → 503 `worker_stale` si falta; (5) **visibilidad de colas**: `GET /admin/queues` (AdminGuard) con counts + últimos 10 failed + página `/admin/queues` en el panel super admin.

**Resultado**: el SaaS cobra por SEPA (medio dominante en España) y tarjeta, deja que el inquilino pague desde su portal, puede auto-cobrar al emitir, es idempotente frente a reintentos de Stripe, reporta errores a Sentry, expone un readiness probe real y un health del worker, y arranca limpio en una BD desde cero. **Sigue sin haber TODOs ni tests skipped.** Pendiente: alerta Grafana sobre `/api/csp-report` (externo). Lo único que queda para facturar de verdad es **operativo, no código**: desplegar el VPS + dry-run AEAT sandbox con cert FNMT real.

## Despliegue en producción ✅ (2026-06-16)

Primer despliegue real sobre **VPS con Portainer + Nginx Proxy Manager** (stack de tipo Repository: Portainer clona el repo y construye las imágenes con `docker-compose.portainer.yml`). Se sanearon los Dockerfiles de producción (que nunca se habían construido end-to-end) y se añadió `apps/api/src/scripts/bootstrap.ts` (siembra de planes + super admin, idempotente). App viva sobre un dominio de prueba. Detalle en `docs/DEPLOYMENT.md` (§6B Portainer, §7 bootstrap). **Pendiente para el primer cliente real (operativo, no código):** Resend con dominio definitivo (hoy `RESEND_API_KEY` inválida), Stripe live + webhook, cert FNMT + `AEAT_MODE` sandbox→production, Uptime Kuma a `/health/ready` y `/health/worker`, y cron de backups a Backblaze B2.

## Backlog de valor añadido (post-MVP)

Análisis de funcionalidades y mejoras para diferenciar el producto, ordenado por su impacto para un operador de self-storage en España. La lente: **(a)** reducir trabajo manual del staff (local desatendido), **(b)** cobrar más y mejor (menos morosidad, mejor precio/trastero), **(c)** captar y migrar clientes.

### Quick wins (alto impacto / esfuerzo bajo-medio)

- **Importador de datos (CSV/Excel)** para onboarding: migrar clientes/contratos/trasteros desde el sistema del competidor. Sin esto, cambiarse de software es un muro. Reutiliza `customers`/`contracts`/`units`. _(plan de implementación detallado más abajo)_
- **WhatsApp Business API real** para dunning y avisos: hoy `WhatsAppProvider` es stub. En España WhatsApp se lee, el email no → más cobro con lo ya construido (outbox + automations). _(plan de implementación detallado más abajo)_
- **Automations infrautilizadas activadas**: confirmación de pago, aviso de renovación, subida de precio con antelación legal (motor `EventEmitter2` + communications ya existe).
- **Centro de notificaciones in-app** + badge en el header (sobre `EventEmitter2`): impagos, incidencias y leads sin depender del email.
- **KPIs de revenue management** en el dashboard: RevPAU (ingreso por trastero disponible), tendencia de ocupación, length-of-stay medio, LTV. Base en `AnalyticsService`.

### Diferenciadores estratégicos (self-storage específico)

- **Move-in 100% self-service online**: el cliente reserva + firma + paga + recibe su código de acceso sin staff. Encadena widget → reservations → contracts → portal de pago → access credentials. Habilita el **local desatendido** (gran argumento del sector).
- **Firma electrónica del contrato**: hoy `sign` es solo transición de estado + PDF. Falta firma real (signature pad / firma por email con sello de tiempo) con rastro en `contract_events`.
- **Integración real de control de accesos**: `LockProvider` está en stub/MQTT. Controladores reales (PTI/Noke/Sensata o controlador de puerta) + acceso del inquilino por QR/PIN desde el móvil.
- **Overlock + flujo de impago físico → subasta**: ya hay `access_block` + `suspendForDunning`; falta el workflow operativo (candado físico, avisos legales escalados, disposición/subasta del contenido con sus particularidades legales en España).
- **App PWA del inquilino**: pago, acceso (QR/PIN), facturas, incidencias.

### Pagos y finanzas (mercado español)

- **Redsys** (TPV bancario): la abstracción `PaymentGateway` ya lo permite. Muchos operadores lo exigen.
- **GoCardless** para SEPA recurrente (más barato que Stripe para domiciliación).
- **Integración contable Holded / A3 / Sage**: exportar facturas/cobros. Argumento de cierre para PYME española.
- **Conciliación bancaria** (norma 43): casar cobros con el extracto.
- **Informes fiscales** más allá de Veri\*Factu: libro registro de IVA, soporte 303/347.

### Crecimiento y CRM

- **Landing pública por local con disponibilidad + "reservar ahora"** (SEO): extiende el widget actual.
- **Reviews / NPS** post-contratación automatizado.
- **Campañas segmentadas** (email/WhatsApp) sobre el módulo communications: reactivación de leads, upsell de seguro/productos.
- **Programa de referidos** + promociones avanzadas (`promotions` ya existe).

### Analítica e IA

- **Predicción de churn** + **precio dinámico** por ocupación (yield management): empezar por reglas heurísticas sobre `pricing_rules` antes de ML.
- **Forecasting** de ocupación e ingresos.
- **Asistente IA para staff** (resúmenes de cliente, redacción de comunicaciones).

### Plataforma y robustez técnica

- **Multi-idioma EN/CA/FR** (i18n con next-intl ya montado; hoy solo `es-ES`).
- **Permisos más finos** + 2FA obligatorio configurable por más roles.
- **Observabilidad**: dashboards Grafana/Loki sobre `security_events`/colas + alerta sobre `/api/csp-report`.
- **Playwright en CI bloqueante** + más cobertura e2e de los flujos de dinero.
- **Apps separadas** portal e admin (hoy rutas en `apps/web`).
- **Marketplace público de trasteros**.
- Más endpoints públicos `/v1/integrations/*` según el primer integrador.

### Prioridad recomendada

| #   | Iniciativa                                   | Por qué                                                                       |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Importador CSV/Excel                         | Sin esto migrar un cliente desde otro software es un muro. Permite vender ya. |
| 2   | WhatsApp real (dunning + avisos)             | Mayor ROI inmediato: cobra más con lo ya construido a medias.                 |
| 3   | Move-in self-service + firma electrónica     | El diferenciador del sector (local desatendido).                              |
| 4   | Redsys + Holded                              | Quitan objeciones de compra típicas en España.                                |
| 5   | Control de accesos real + PWA inquilino      | Completa la experiencia desatendida.                                          |
| 6   | Revenue management (KPIs + pricing dinámico) | Aumenta ingresos del cliente → justifica el precio del SaaS.                  |

> **Antes que cualquier feature**: terminar la configuración operativa del despliegue (Resend, Stripe live, AEAT producción) — sin eso el producto no opera de verdad con un cliente.

> Nota: **API pública + webhooks** ya NO es backlog (Fases 14-15: API keys + webhooks HMAC + scopes + retry + dashboard). La limpieza de `webhook_deliveries` ya es un cron (`WebhooksCleanupService`). El **KPI de inquilinos** se implementó (`GET /analytics/customers` + `<CustomersKpiCard>`).

## Criterio de "MVP listo para vender"

Fases 0 a 4 completas + un subset esencial de la 5 (al menos email transaccional y recordatorios de pago) + Fase 8 mínima para poder cobrar suscripciones.
