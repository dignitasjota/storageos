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
- [ ] CI básico (GitHub Actions): lint + typecheck + build

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
- [ ] **Dunning gate access_block**: hook desde `DunningProcessor` cuando `action_type='access_block'` invoca `CredentialsService.suspend(customerId)`. Aplazado: pendiente conectar.

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

## Backlog / Post-MVP

- App móvil (React Native o PWA)
- WhatsApp Business API
- Marketplace público de trasteros
- API pública + webhooks
- IA: predicción de churn, recomendación de precios
- Multi-idioma completo
- Firma biométrica en tablet
- Integración con software contable español (Holded, A3)

## Criterio de "MVP listo para vender"

Fases 0 a 4 completas + un subset esencial de la 5 (al menos email transaccional y recordatorios de pago) + Fase 8 mínima para poder cobrar suscripciones.
