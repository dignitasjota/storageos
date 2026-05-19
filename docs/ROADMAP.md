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

### 1E — User management + invitaciones + audit logs

- [ ] Endpoints CRUD `/users` con permisos por rol
- [ ] Invitaciones (`POST /invitations`, `GET /invitations/:token`, `POST /invitations/:token/accept`) con expiracion 7d
- [ ] Audit logs ampliados: user.created, user.role_changed, invitation.sent/accepted/revoked
- [ ] Pagina de gestion de usuarios en el panel

### 1F — 2FA TOTP

- [ ] `POST /auth/2fa/setup`, `POST /auth/2fa/verify`, `POST /auth/2fa/disable`
- [ ] Codigos de recuperacion (10, single-use)
- [ ] Forzar 2FA para roles `owner` y `manager` (politica gradual)
- [ ] UI de enrolment y verificacion

## Fase 2 — Locales, trasteros y plano (1-2 semanas)

- [ ] Schema: `facilities`, `facility_floors`, `unit_types`, `units`, `unit_status_history`
- [ ] API CRUD para facilities, unit_types, units
- [ ] Frontend: gestión de facilities
- [ ] Frontend: gestión de unit_types con colores
- [ ] **Editor visual de planos** con react-konva:
  - Cargar imagen de plano de fondo (subida a MinIO)
  - Crear/editar trasteros como rectángulos sobre el plano
  - Snap a grid, edición de medidas
  - Asignar unit_type, código, precio base
  - Vista de estados con código de colores en tiempo real
- [ ] Vista de listado de trasteros con filtros (estado, tipo, precio)
- [ ] Dashboard de ocupación: % por facility, por tipo

## Fase 3 — Inquilinos, contratos y reservas (2 semanas)

- [ ] Schema: `customers`, `customer_documents`, `contracts`, `contract_events`, `reservations`
- [ ] CRUD de inquilinos con documentos (subida de DNI/CIF a MinIO)
- [ ] CRUD de contratos:
  - Asignación cliente ↔ trastero
  - Cálculo de precio con tarifas y descuentos
  - Generación de PDF con plantilla (Puppeteer)
  - Estados del contrato y transiciones permitidas
  - Sincronización automática del estado de `units`
- [ ] Reservas con bloqueo temporal del trastero
- [ ] Vista de timeline del contrato (eventos)

## Fase 4 — Facturación y pagos (2-3 semanas)

- [ ] Schema: `invoices`, `invoice_items`, `invoice_series`, `payments`, `payment_methods`, `dunning_actions`, `pricing_rules`, `promotions`
- [ ] **Verifactu compliance desde MVP** (obligatorio para sociedades desde 2026-01-01). Ver detalle en `docs/DATA_MODEL.md` → "Pendiente Fase 4 — Verifactu".
- [ ] Schema RGPD: `data_subject_requests`, `consents`. Ver `docs/DATA_MODEL.md` → "Pendiente RGPD".
- [ ] Integración Stripe: tarjeta + Stripe SEPA
- [ ] Integración GoCardless (opcional en MVP)
- [ ] Job recurrente con BullMQ para generar facturas mensuales
- [ ] Generación de PDFs de facturas (con QR Verifactu)
- [ ] Gestión de impagos: reintentos, recargos, escalado
- [ ] Portal de facturas para inquilino (descarga + pago online)
- [ ] Exportación contable (CSV)

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
