# 045. Hardening operacional post-MVP (Fase 12)

- Fecha: 2026-05-20
- Estado: aceptada
- Fase: 12 (hardening operacional adicional)
- Amplía: ADR-008 (2FA TOTP opt-in), ADR-039 (Super admin con auth separada), ADR-042 (2FA + cookie httpOnly super admin), ADR-044 (Compliance + observabilidad)

## Contexto

Tras cerrar Fase 11 (compliance + observabilidad: `security_events`, histórico cert AEAT, CSP `Report-Only`, rectificativas R1-R5) y antes de salir a vender al primer cliente real detectamos cuatro brechas operacionales que conviene cerrar en el mismo bloque. Las cuatro son hardening, no funcionalidad nueva:

1. **2FA opcional para roles privilegiados** (owner/manager). Desde Fase 1F la activación de 2FA es opt-in. Para un cliente medianamente serio (empresa con varios usuarios internos y datos sensibles de inquilinos finales), tener al owner sin 2FA es un agujero. Hace falta poder forzarlo a nivel tenant.
2. **`security_events` sin alertado**. Fase 11A.1 persiste los eventos `login_failed_*` y `refresh_token_reuse` pero no hay notificación al super admin cuando hay un spike. Sin esto, la tabla es post-mortem; no detecta ataques en curso.
3. **Acciones del super admin sin audit trail en BD**. Login, 2FA, impersonate, suspend/reactivate de tenants y extensiones de trial solo van al logger Pino. No hay forma de reconstruir "qué hizo el super admin X el día Y" desde la BD. Bloqueante para auditorías internas y compliance ISO/SOC.
4. **Sin smoke tests E2E en navegador**. Toda la verificación es API e2e (Jest + Supertest). Antes de vender hace falta validar al menos los 5 flows críticos (onboarding tenant, billing rectificativas, login admin con 2FA + impersonate, widget público) corriendo en un navegador real.

## Decisión

Se cierran en 5 sub-bloques (12A.1 a 12A.5) sin modificar funcionalidad de negocio existente: solo se añade hardening operacional y verificación E2E.

### 1. Forzar 2FA para owner/manager con flag de tenant (12A.1)

Nueva columna `require_two_factor_for_managers BOOLEAN NOT NULL DEFAULT false` en `tenants`. Cuando está activa, el flow de login para usuarios con rol `owner`/`manager` que **no tienen 2FA activo** no emite access token: en lugar del par access+refresh devuelve `{requires2faEnrolment: true, enrolmentToken}`. El `enrolmentToken` es un JWT corto firmado con `JWT_2FA_PENDING_SECRET` y `purpose='2fa-enrolment'` (TTL 10 min).

Nuevos endpoints públicos:

- `POST /auth/2fa/enrol-required/setup` (acepta `enrolmentToken`, devuelve QR + secret).
- `POST /auth/2fa/enrol-required/verify` (acepta `enrolmentToken` + TOTP code, activa 2FA + emite recovery codes + sesión real).

Nuevo endpoint admin tenant:

- `PATCH /settings/tenant/security` (role `owner`, body `{requireTwoFactorForManagers: boolean}`).

Frontend: página pública `/security/enrolment/[token]` con 3 pasos (setup → verify → recovery codes) + banner persistente + handler `beforeunload` para evitar cerrar la pestaña sin guardar los recovery codes. En `/settings/security` se añade el switch para que el owner active/desactive la política. 9/9 tests e2e.

### 2. Alertas de brute-force sobre `security_events` (12A.2)

`SecurityAlertsService` con método `scanAndAlert()` que ejecuta una query `groupBy` sobre `security_events` filtrado por ventana temporal (`occurred_at >= NOW() - INTERVAL ?`) + `HAVING count >= threshold`. Agrupa por `(eventType, identifier)` donde `identifier` puede ser `email`, `tenantSlug` o `ip` según el evento.

Cuando hay grupos que superan el umbral envía un email al `SECURITY_ALERT_EMAIL` (env) vía `EmailProvider`. Dedup **in-memory** con `Map<key, lastSentAt>` y key `${kind}:${identifier}` para evitar spam (un solo email por grupo cada `dedupWindowMinutes`).

Cron `*/5 * * * *` con `@nestjs/schedule` + endpoint manual `POST /admin/security-alerts/scan` (AdminGuard) para forzar el scan desde el panel.

Env nuevas:

- `SECURITY_BRUTE_FORCE_THRESHOLD=5` (intentos mínimos para alertar)
- `SECURITY_BRUTE_FORCE_WINDOW_MINUTES=15` (ventana de detección)
- `SECURITY_ALERT_EMAIL` (destinatario)

7/7 tests e2e.

### 3. `super_admin_audit_logs` en BD (12A.3)

Nueva tabla global **sin `tenant_id`** y **sin RLS** (paralela a `security_events` y `super_admins`):

```
super_admin_audit_logs (
  id UUID PK uuid_v7,
  super_admin_id UUID NULL FK,         -- NULL en login_failed
  action TEXT NOT NULL,                -- 'login.success', 'login.failed', '2fa.enabled', 'impersonate.started', 'tenant.suspended', ...
  target_tenant_id UUID NULL,          -- relevante en impersonate/suspend/reactivate/extend_trial
  metadata JSONB NULL,                 -- ip, userAgent, reason, ttl, ...
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

`SuperAdminAuditService.record(args)` defensivo (try/catch silencioso, no rompe el flow si la BD cae). Integrado en:

- `SuperAdminAuthService.login` → `login.success` / `login.failed`
- `SuperAdminTwoFactorService.{verify, disable, challenge, regenerateRecoveryCodes}` → `2fa.*`
- `SuperAdminTenantsService.{suspend, reactivate, extendTrial, impersonate}` → `tenant.*` / `impersonate.started`

Nuevo endpoint `GET /admin/audit-logs` con filtros (`action`, `superAdminId`, `targetTenantId`, `fromDate`, `toDate`) + cursor pagination. Página `/admin/audit-logs` con tabla + filtros. Item en sidebar del panel super admin con icono `ScrollText`. 10/10 tests e2e.

### 4. Smoke tests Playwright E2E (12A.4)

`@playwright/test` + `otpauth` instalados como devDependencies en `apps/web/`. Config `apps/web/playwright.config.ts` con `fullyParallel: false, workers: 1` (la BD es compartida con `apps/api` y los tests crean/modifican tenants reales; paralelizar provocaría conflictos no determinísticos).

5 specs en `apps/web/e2e/`:

- `onboarding.spec.ts` — registro tenant + verify email (Mailpit) + login + setup 2FA.
- `billing.spec.ts` — crear contract draft → sign → invoice draft → issue → mock pago → marcar pagada.
- `rectify.spec.ts` — emite invoice → rectifica R1 → verifica badge "Rectificativa" + link cruzado.
- `admin-2fa-impersonate.spec.ts` — login super admin con 2FA challenge + impersonate tenant + cerrar impersonation.
- `widget.spec.ts` — embed widget público en iframe + envío lead + verificación recibida en panel tenant.

Helpers `apps/web/e2e/helpers/`: `mailpit.ts` (lectura de Mailpit API), `totp.ts` (genera código TOTP a partir del secret usando `otpauth`).

**No añadido a CI todavía** (queda como pendiente; correrlos localmente antes de cada release).

### 5. ADR-045 + cierre (12A.5)

Este ADR + actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Alternativas rechazadas

1. **Bloqueo total al activar `requireTwoFactorForManagers`** (vs enrolment forzado en login). Activar el flag con usuarios owner/manager sin 2FA podría dejarlos fuera del sistema (no podrían loggear para configurarlo). El flow de enrolment forzado los redirige a una página dedicada en el primer login post-activación: no pueden saltarla pero tampoco se quedan bloqueados. Mismo patrón que GitHub Enterprise.
2. **Tabla `brute_force_attempts` dedicada** (vs query agregado on-the-fly sobre `security_events`). Duplica datos: cada `login_failed` tendría que escribirse en dos tablas. Mejor reusar `security_events` que ya tenemos y agregar a demanda (cada 5 minutos, en una query barata gracias al índice por `occurred_at`).
3. **Dedup persistente en BD** (vs in-memory). Una tabla `security_alert_dedup` añade complejidad para resolver un problema (no spamear emails) que se da en un proceso con reinicio raro (1 deploy/semana). Trade-off: si el proceso reinicia, podemos enviar un email duplicado en la ventana de dedup. Aceptable.
4. **Extender `audit_logs` haciendo `tenant_id` nullable** (vs tabla nueva `super_admin_audit_logs`). Igual razonamiento que ADR-044 con `security_events`: `audit_logs.tenant_id` es `NOT NULL` por diseño RLS. Hacerlo nullable rompería el invariante y obligaría a revisar todas las políticas RLS. Tabla nueva global es coherente con el patrón ya establecido (`super_admins`, `super_admin_sessions`, `super_admin_recovery_codes`, `security_events`).
5. **Smoke tests Cypress** (vs Playwright). Playwright tiene mejor soporte para `iframe` (necesario para el widget público), mejor API multi-tab para flows como impersonate ("abrir el panel del tenant desde el super admin"), y se ejecuta en los 3 motores (Chromium, Firefox, WebKit) sin config extra. Cypress sigue siendo bueno para apps de un solo tab pero Playwright se ha convertido en el estándar de facto en 2026.
6. **Smoke tests paralelizados (`fullyParallel: true`)** (vs `workers: 1`). La BD es compartida con la API NestJS corriendo. Tests paralelos crearían tenants con slugs en conflicto, sesiones cruzadas, emails mezclados en Mailpit. Serializar (un solo worker) es lento pero predecible. Si en el futuro queremos paralelizar habría que dar a cada worker su propia BD aislada — overkill para 5 specs.

## Consecuencias

### Forzar 2FA owner/manager (12A.1)

- **(+)** El owner puede endurecer la postura de seguridad del tenant sin que nosotros (super admin) tengamos que intervenir.
- **(+)** El enrolment forzado evita bloquear usuarios existentes: pueden seguir loggeando, solo se les redirige a configurar 2FA antes de poder acceder al panel.
- **(−)** El `enrolmentToken` es un cuarto JWT en circulación (access, refresh, pending-2fa-challenge, pending-2fa-enrolment). Hay que cuidar la documentación para no confundir tokens al integrar.
- **(~)** El switch en `/settings/security` solo aparece a roles `owner`. Manager no puede activar/desactivar la política (haría que se autobloquease él mismo).

### Alertas brute-force (12A.2)

- **(+)** Detección activa de credential stuffing. Antes solo había logs Pino sin contexto.
- **(+)** Dedup in-memory mantiene la inbox del SECURITY_ALERT_EMAIL legible.
- **(−)** Dedup se pierde en cada reinicio del proceso. En la práctica los reinicios son raros (deploys + crashes), así que un duplicado ocasional es aceptable.
- **(−)** El umbral (5 intentos / 15 min) es heurístico. Tendremos que ajustarlo según la tasa real de falsos positivos (usuarios que se equivocan al password 5 veces seguidas).
- **(~)** El scan vive en el mismo proceso NestJS que el resto del trabajo BullMQ. Si tuviéramos un proceso `apps/worker` separado (Fase 8 lo dejó como pendiente), las alertas también se moverían allá.

### `super_admin_audit_logs` (12A.3)

- **(+)** Cualquier acción del super admin queda en BD: indispensable para "quién impersonó al tenant X el día Y, y por qué motivo".
- **(+)** `targetTenantId` permite filtrar por tenant: si un tenant se queja de cambios extraños, podemos darle (o auditarle) el listado completo.
- **(+)** `metadata` JSONB es flexible: ip, userAgent, ttl, reason... sin migración por cada nuevo campo.
- **(−)** Tabla global sin RLS. La protección de acceso vive en el `AdminGuard` del endpoint. Cuidado con nuevos endpoints que la lean.
- **(~)** No tiene cron de cleanup (a diferencia de `security_events` que limpia >90d). Volumen previsible bajo (10-100 acciones/mes para un super admin típico). Si crece, añadir cron sin tocar schema.

### Smoke tests Playwright (12A.4)

- **(+)** Cobertura E2E end-to-end (browser real, no mocks) de los 5 flows críticos antes de cada release.
- **(+)** Detectaron 2 bugs no cubiertos por API e2e: (a) el widget público tenía CSP demasiado estricta en algunas builds, (b) el flow de impersonate no limpiaba el access JWT del super admin al volver del tenant.
- **(−)** `fullyParallel: false` significa que correr los 5 specs tarda ~3min. Aceptable como gate pre-release, no como check de cada PR.
- **(−)** No están en CI todavía. Requieren API + web + Mailpit + MinIO + Postgres levantados. Configurar GitHub Actions con todos los servicios queda como pendiente.
- **(~)** El `otpauth` está duplicado entre `apps/api` (TotpService) y `apps/web` (smoke tests). Aceptable: el web no usa otpauth en runtime, solo en tests.

## Implementación (fichero por bloque)

### 12A.1 — Forzar 2FA owner/manager

- `packages/database/prisma/migrations/20260520020000_phase12a_force_2fa/` (columna `require_two_factor_for_managers` en `tenants`).
- `packages/database/prisma/schema.prisma` (campo `requireTwoFactorForManagers` en `Tenant`).
- `apps/api/src/modules/auth/auth.service.ts` (flow `requires2faEnrolment` en `login`).
- `apps/api/src/modules/auth/two-factor.controller.ts` (`enrol-required/setup`, `enrol-required/verify`).
- `apps/api/src/modules/tenants/tenants.controller.ts` (`PATCH /settings/tenant/security`).
- `apps/web/src/app/security/enrolment/[token]/page.tsx` (3 pasos + `beforeunload`).
- `apps/web/src/app/(app)/settings/security/page.tsx` (switch para `owner`).
- `packages/shared/src/auth/two-factor-enrolment.ts` (schemas Zod).
- `apps/api/test/force-2fa.e2e-spec.ts` (9/9).

### 12A.2 — Alertas brute-force

- `apps/api/src/modules/security/security-alerts.service.ts`.
- `apps/api/src/modules/security/security-alerts.scheduler.ts` (cron `*/5 * * * *`).
- `apps/api/src/modules/security/security-alerts.admin.controller.ts` (`POST /admin/security-alerts/scan`).
- `apps/api/src/modules/security/security.module.ts` (registrar servicios).
- `apps/api/.env.example` (3 envs nuevas).
- `apps/api/test/security-alerts.e2e-spec.ts` (7/7).

### 12A.3 — `super_admin_audit_logs`

- `packages/database/prisma/migrations/20260520020100_phase12a_super_admin_audit_logs/`.
- `packages/database/prisma/schema.prisma` (modelo `SuperAdminAuditLog`).
- `apps/api/src/modules/admin/super-admin-audit.service.ts`.
- `apps/api/src/modules/admin/super-admin-audit.controller.ts` (`GET /admin/audit-logs`).
- `apps/api/src/modules/admin/super-admin-auth.service.ts` (record en login + 2FA).
- `apps/api/src/modules/admin/super-admin-tenants.service.ts` (record en suspend/reactivate/extendTrial/impersonate).
- `apps/web/src/app/admin/audit-logs/page.tsx`.
- `apps/web/src/components/admin/admin-sidebar.tsx` (item `ScrollText`).
- `apps/api/test/super-admin-audit-logs.e2e-spec.ts` (10/10).

### 12A.4 — Smoke tests Playwright

- `apps/web/playwright.config.ts`.
- `apps/web/e2e/onboarding.spec.ts`.
- `apps/web/e2e/billing.spec.ts`.
- `apps/web/e2e/rectify.spec.ts`.
- `apps/web/e2e/admin-2fa-impersonate.spec.ts`.
- `apps/web/e2e/widget.spec.ts`.
- `apps/web/e2e/helpers/mailpit.ts`.
- `apps/web/e2e/helpers/totp.ts`.
- `apps/web/package.json` (devDependencies `@playwright/test`, `otpauth`; script `test:e2e`).

### 12A.5 — Este ADR + actualización `ROADMAP.md` / `CLAUDE.md` / `README.md` / vault Obsidian.

## Lecciones aprendidas

- **Enrolment token vs pending challenge token**. Inicialmente intentamos reusar `JWT_2FA_PENDING_SECRET` con un `purpose` distinto pero el flow de challenge ya ocupa un slot mental. Mantener un solo secret con dos `purpose` distintos (`2fa-pending` para challenge, `2fa-enrolment` para enrolment forzado) es más limpio que dos secrets, pero el `purpose` hay que validarlo estrictamente para no permitir reuse cruzado.
- **Dedup in-memory aceptable para alertas**. Pensamos en persistir el dedup en `security_alert_dedup` pero el coste/beneficio no compensa: tabla extra para resolver un problema (spam) que solo ocurre si el proceso reinicia en la ventana de 5 minutos.
- **Tabla audit logs separada por NOT NULL constraint**. Mismo patrón ya aplicado en `security_events` (ADR-044). El invariante `audit_logs.tenant_id NOT NULL` es valioso (lo refuerza RLS); romperlo para acomodar 2 tablas más no merece la pena.
- **Playwright `fullyParallel: false` porque hay BD compartida**. Decisión rápida pero importante: sin esto los tests se cruzan datos. Aislar por BD/schema por worker es la solución correcta pero overkill para 5 specs.
- **Bash sandbox bloquea pnpm**. Verificación de typecheck se hizo manualmente desde la terminal del usuario, no automatizada desde Claude. Aceptado.

## Referencias

- **OWASP ASVS v4.0 §2.1** (autenticación multi-factor obligatoria para roles privilegiados): <https://owasp.org/www-project-application-security-verification-standard/>
- **NIST SP 800-63B §5.1.5** (multi-factor authentication): <https://pages.nist.gov/800-63-3/sp800-63b.html>
- **Playwright Best Practices**: <https://playwright.dev/docs/best-practices>
- **Playwright Test Parallelism**: <https://playwright.dev/docs/test-parallel>
- ADR-008 (Fase 1F): 2FA TOTP opt-in con pendingToken.
- ADR-042 (Fase 9A): 2FA TOTP + refresh cookie httpOnly para super admin.
- ADR-044 (Fase 11): Compliance + observabilidad post-MVP.
