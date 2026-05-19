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

## Fase 5 — Comunicaciones y CRM básico (1-2 semanas)

- [ ] Schema: `leads`, `communications`, `message_templates`, `automation_rules`
- [ ] Integración con Resend para emails transaccionales
- [ ] Plantillas con variables: bienvenida, recordatorio de pago, aviso de impago, fin de contrato
- [ ] Pipeline de leads con kanban
- [ ] Widget de reserva embebible para la web del cliente

## Fase 6 — Operativa y reporting (1 semana)

- [ ] Schema: `tasks`, `incidents`, `products`, `product_sales`
- [ ] Gestión de tareas e incidencias
- [ ] Venta de productos accesorios
- [ ] Dashboard analítico con KPIs: ocupación física vs económica, MRR, churn, morosidad
- [ ] Informes exportables a Excel/PDF

## Fase 7 — Control de accesos físicos (variable)

Dependiente del hardware que se quiera soportar.

- [ ] Schema: `access_credentials`, `access_logs`, `access_devices`
- [ ] Generación de PINs/QRs
- [ ] Bloqueo automático por impago
- [ ] Integración inicial con un proveedor de cerraduras (a elegir)

## Fase 8 — Super Admin y facturación SaaS (1 semana)

- [ ] Panel super admin: listado de tenants, métricas globales, soporte
- [ ] Stripe Billing para facturación de los tenants
- [ ] Onboarding de nuevo tenant con trial

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
