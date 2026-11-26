# API

> Estado: **MVP cerrado (Fase 14)** — auth + multi-tenant (Fase 1),
> facilities + units + editor visual (Fase 2), contratos + reservas
> (Fase 3), facturacion + Verifactu + pagos + dunning + RGPD + portal
> (Fase 4), comunicaciones + automations + CRM + widget (Fase 5),
> operativa + productos + analytics + reports (Fase 6), accesos fisicos
> (Fase 7), super admin + soporte + SaaS billing (Fase 8 + 9A),
> Veri\*Factu real con mTLS (Fase 10), compliance + observabilidad
> (Fase 11: `security_events`, historial AEAT, CSP, rectificativas R1-R5
> por diferencias), hardening operacional (Fase 12: forzar 2FA
> owner/manager, alertas brute-force, `super_admin_audit_logs`),
> versionado `/v1/` + OpenAPI + F2 + rectificativas por sustitucion
> (Fase 13) e integraciones API keys + webhooks salientes HMAC
> (Fase 14).

### El primer pago en un solo pago (2026-11-19)

Área de clientes: `POST /portal/me/invoices/:id/charge`, `…/redsys-redirect` y `…/offline-payment` con el id de una fianza ligada a una factura aún por pagar cobran la factura (que incluye la fianza). `POST /invoices/:id/mark-paid` admite `includeBundledDeposit` (registra también la fianza pendiente, con la misma forma de pago, si la factura queda pagada). `InvoiceDto.bundledDeposit {id, invoiceNumber, total, amountPending, status}`. `GET /invoices/page|totals?awaitingPayment=true` (primeros pagos sin cobrar) y `search` busca también por número de contrato; el pendiente de los totales cuenta el primer pago. `TodayDto.firstPaymentsPending`.

### Citas de los comerciales (2026-11-18)

Comercial (su cartera): `GET /admin/sales/appointments?leadId=&scope=upcoming|past|all` (sin `leadId`, las próximas), `POST /admin/sales/accounts/:leadId/appointments` (`kind` in_person|call|video, `title`, `startsAt` ISO con zona, `durationMinutes`, `location`, `notes`), `PATCH /admin/sales/appointments/:id` (también `status` scheduled|done|cancelled|no_show), `DELETE /admin/sales/appointments/:id`. Dirección (superadmin): `GET /admin/sales-team/appointments?repId=&leadId=&scope=`, `POST /admin/sales-team/appointments` (+ `leadId` y `repId`; sin `repId`, el comercial del lead), `PATCH|DELETE /admin/sales-team/appointments/:id`. Errores: 400 `appointment_in_past`, `appointment_too_far`, `appointment_rep_required`, `appointment_rep_mismatch`, `invalid_rep`; 404 `appointment_not_found`. `SalesTodayDto.appointments` (las pendientes de hoy).

## Convenciones

- **Base path actual:** todas las rutas viven bajo el prefijo `/v1/` —
  por ejemplo `POST /v1/auth/login`, `GET /v1/invoices`. El servidor
  responde **308 Permanent Redirect** a la version actual cuando un
  cliente apunta a una URL sin prefijo, preservando metodo HTTP y body.
- **Excepciones al versioning** (sirven en su path historico, sin `/v1/`):
  - `GET /health` — readiness probes / uptime monitors.
  - `POST /webhooks/*` — Stripe, Resend, GoCardless... URLs registradas
    en cada dashboard externo.
  - `GET|POST /public/widget/*` — embeds ya desplegados en sitios del
    cliente final.
  - `GET /api/docs` y `GET /api/docs-json` — documentacion interactiva.
- **OpenAPI / Swagger UI:** disponible en `GET /api/docs` (UI) y
  `GET /api/docs-json` (schema crudo). En dev/test se monta siempre; en
  produccion solo si `OPENAPI_ENABLED=true` (y debe quedar detras de auth
  en Nginx Proxy Manager o VPN).
- **Auth:** `Authorization: Bearer <access_token>` (JWT HS256). El refresh
  viaja por cookie `httpOnly` (no se accede desde JS).
- **Tenant:** identificado por el access token; ningun endpoint acepta
  `tenant_id` como parametro. La extension Prisma + RLS hacen el filtro
  automatico.
- **Formato:** JSON con `Content-Type: application/json; charset=utf-8`.
- **Casing:** `snake_case` en BD ↔ `camelCase` en la API. Prisma hace el
  mapping.
- **Paginacion (futura):** cursor-based con `?cursor=...&limit=...`.
- **Filtros y orden (futuros):** `?filter[field]=value`, `?sort=field` o
  `?sort=-field`.
- **Errores:** envoltorio uniforme.

  ```json
  {
    "statusCode": 400,
    "error": "Bad Request",
    "message": "Validacion fallida",
    "details": [{ "path": "email", "message": "Email no valido" }]
  }
  ```

  El campo `error` siempre lleva el reason-phrase HTTP humanizado
  (`Bad Request`, `Unauthorized`, `Too Many Requests`, ...). `details` solo
  aparece en errores de validacion.

- **Validacion:** schemas Zod compartidos en `@storageos/shared/auth` se
  vinculan al body con `nestjs-zod`.
- **Rate limiting:** un `ThrottlerGuard` global aplica un limite "default"
  de 60/min por IP. Los endpoints sensibles lo sobreescriben con presets
  (ver "Rate limiting" abajo).
- **CSRF:** no aplica en la API JSON (Auth header). El refresh cookie usa
  `sameSite=lax` (dev) / `sameSite=strict` (prod).

## Salud

| Metodo | Ruta             | Auth | Descripcion                                                                                                                                               |
| ------ | ---------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`        | NO   | Liveness probe. `{ status, timestamp }`.                                                                                                                  |
| GET    | `/health/ready`  | NO   | Readiness: `SELECT 1` a Postgres + `PING` a Redis. 503 con `details: { database, redis }` si algo cae. **Uptime Kuma debe apuntar aquí**, no a `/health`. |
| GET    | `/health/worker` | NO   | Heartbeat del worker (`workers:heartbeat` en Redis, TTL 3 min). 503 `worker_stale` si falta el latido.                                                    |

---

## Autenticacion

Modulo `apps/api/src/modules/auth/`. Cubre registro, login, refresh con
rotacion + deteccion de reuso, logout (individual y global) y `/me`.

### Tokens

- **Access token (JWT HS256):**
  - Payload: `{ sub: userId, tenantId, role, iat, exp }`.
  - TTL: `JWT_ACCESS_TTL_SECONDS` (default 900s = 15 min).
  - Transporte: `Authorization: Bearer <token>`.
- **Refresh token (opaco):**
  - Formato: `<tenantId>.<sessionId>.<secret>` (3 segmentos UUID/base64url).
  - El `tenantId` permite resolver RLS sin necesidad de cliente admin.
  - El `secret` son 32 bytes random base64url. Solo el hash argon2id se
    persiste en la tabla `sessions`.
  - TTL: `JWT_REFRESH_TTL_SECONDS` (default 604800s = 7 dias).
  - Transporte: cookie `refresh_token`, `HttpOnly`, `Path=/auth`,
    `Domain=COOKIE_DOMAIN`, `Secure=COOKIE_SECURE`,
    `SameSite=COOKIE_SAMESITE`, `Max-Age=TTL`.

### Endpoints

| Metodo | Ruta                        | Auth | Throttle  | Descripcion                                                                          |
| ------ | --------------------------- | ---- | --------- | ------------------------------------------------------------------------------------ |
| POST   | `/auth/register`            | NO   | 3/hora/IP | Crea tenant + owner + serie de facturación por defecto; envia email; no emite tokens |
| POST   | `/auth/login`               | NO   | 5/min/IP  | Login `(tenantSlug, email, password)`                                                |
| POST   | `/auth/refresh`             | NO   | 30/min/IP | Rota refresh y emite nuevo access                                                    |
| POST   | `/auth/verify-email`        | NO   | 30/min/IP | Activa la cuenta con el token del email; emite sesion                                |
| POST   | `/auth/resend-verification` | NO   | 3/hora/IP | Reenvia el email de verificacion; 204 generico                                       |
| POST   | `/auth/password/forgot`     | NO   | 3/hora/IP | Pide reset; envia email; 204 generico                                                |
| POST   | `/auth/password/reset`      | NO   | 5/min/IP  | Cambia password con el token; revoca todas las sesiones                              |
| POST   | `/auth/logout`              | SI   | 60/min/IP | Revoca la sesion actual                                                              |
| POST   | `/auth/logout-all`          | SI   | 60/min/IP | Revoca todas las sesiones del user                                                   |
| GET    | `/auth/me`                  | SI   | 60/min/IP | Devuelve `{ user, tenant, subscription }`                                            |

#### POST `/auth/register`

**Body:**

```json
{
  "tenantName": "Acme Self Storage",
  "tenantSlug": "acme",
  "fullName": "Jane Doe",
  "email": "jane@acme.com",
  "password": "Secret123",
  "acceptTerms": true
}
```

- `tenantSlug` es opcional; si se omite, el backend lo deriva de
  `tenantName` aplicando `slugify` y un sufijo numerico si colisiona.
- `password`: 8-128 chars, ≥1 mayuscula, ≥1 minuscula, ≥1 digito.
- `acceptTerms` debe ser literalmente `true`.

**Respuestas:**

- `201 Created` + cookie `refresh_token`:

  ```json
  {
    "user":         { "id", "email", "fullName", "role", "twoFactorEnabled" },
    "tenant":       { "id", "name", "slug", "status", "trialEndsAt", "locale", "currency", "timezone" },
    "subscription": { "status", "planSlug", "currentPeriodStart", "currentPeriodEnd", "cancelAtPeriodEnd" },
    "accessToken":  "eyJ...",
    "expiresIn":    900
  }
  ```

- `400 Bad Request` ante body invalido (con `details`).
- `409 Conflict` si el slug ya existe.

#### POST `/auth/login`

**Body:** `{ tenantSlug, email, password }`. El email es unico por tenant,
por eso se exige el slug en el login (un mismo email puede pertenecer a
varios tenants).

**Respuestas:**

- `200 OK` + cookie `refresh_token`: mismo cuerpo que `register`.
- `401 Unauthorized` con `message: "Credenciales invalidas"`: tenant
  inexistente, email no registrado en el tenant o password incorrecta. El
  mensaje es **siempre el mismo** para no filtrar si el email existe.
- `403 Forbidden` si la cuenta esta `isActive: false`.

#### POST `/auth/refresh`

Lee la cookie `refresh_token`. **No tiene body.**

**Respuestas:**

- `200 OK` + cookie `refresh_token` (nuevo):

  ```json
  { "accessToken": "eyJ...", "expiresIn": 900 }
  ```

- `401 Unauthorized` ante cookie ausente, formato invalido, secret
  incorrecto, sesion expirada, sesion ya revocada, o tenant manipulado.

##### Flow de refresh rotation + deteccion de reuso

```
Login                                     sessions
  │
  ▼
  Session A (refreshTokenHash=H1)         A: revokedAt=null
  Cookie -> A.secret1
  │
  ▼
POST /auth/refresh con A.secret1
  │
  ▼
  Marca A.rotated; crea B con rotatedFromId=A
  Cookie -> B.secret2                     A: revokedAt=t1, reason='rotated'
                                          B: revokedAt=null
  │
  ▼
POST /auth/refresh con A.secret1 (reuso)
  │
  ▼
  Detecta A revoked -> updateMany
  todas las sesiones del user             A: revokedAt=t1, reason='rotated'
  con revokedAt=null pasan a              B: revokedAt=t2, reason='refresh_reuse'
  reason='refresh_reuse'.
  Lanza 401 Unauthorized.
```

Tras la deteccion de reuso, el atacante (con A) y el usuario legitimo
(con B) **ambos quedan deslogueados**. El usuario debera volver a hacer
login.

#### POST `/auth/logout`

Revoca la sesion del refresh cookie actual. Borra la cookie.

- `204 No Content` (incluso si la cookie estaba ausente o el `tenantId`
  del refresh no coincidia con el del JWT -- en cualquier caso se borra
  la cookie y se devuelve 204).
- `401 Unauthorized` si no hay access token.

#### POST `/auth/logout-all`

Revoca **todas** las sesiones activas del usuario autenticado.

- `204 No Content`.
- `401 Unauthorized` sin access token.

#### GET `/auth/me`

Devuelve `{ user, tenant, subscription, permissions }` del usuario autenticado.
`permissions` es la lista de permisos finos efectivos derivados del rol (ver
"Permisos finos" abajo); el frontend la usa para mostrar/ocultar acciones.

- `200 OK`.
- `401 Unauthorized` sin token o con token invalido/expirado.

### Permisos finos (RBAC de grano fino)

Además del `RolesGuard` (`@Roles(...)`), existe una capa de permisos discretos
`recurso:acción` (`PermissionsGuard` + `@RequirePermission(...)`, cuarto guard
global tras Roles). El catálogo y el mapa rol→permisos viven en
`@storageos/shared` (`permissions.ts`). Un handler usa `@Roles` o
`@RequirePermission` según el grano que necesite; si falta el permiso devuelve
`403 { code: insufficient_permission, details: { requiredPermissions } }`.
Ejemplo de regla más fina que el rol no podía expresar: `POST /invoices/:id/refund`
exige `invoices:refund`, que solo tiene `owner` (aunque `manager` pueda emitir).

**Gating por plan (`@RequireFeature` + `FeatureGuard`, quinto guard global tras
`PermissionsGuard`):** los módulos premium (ai, sepa, bank-reconciliation,
rent-increases, insurance, automations, access) sólo responden si el **plan del
tenant** incluye la feature (`featuresForPlan(plan.slug)`); si no, `403
{ code: feature_not_in_plan, details: { requiredFeature } }`. Es la frontera real;
el `<FeatureGate>` del frontend es cosmético.

**Migración RBAC v2 (en curso):** los módulos se están migrando de `@Roles(...)`
a `@RequirePermission(...)` para que los roles personalizados controlen toda la
app (no solo facturas). Ya migrados: **invoices** y la **operativa diaria** — PR1
(customers, customer-documents, contracts, reservations, contract-signatures,
contract-pdf, leads, tasks, incidents) — y el **inventario/catálogo/comms** — PR2
(facilities, facility-floors, unit-types, units, products, product-stock,
product-sales, communications, message-templates, automations). La autorización
pasa a seguir el catálogo `ROLE_PERMISSIONS`: p. ej. `staff` gana las escrituras
que el catálogo ya le concedía (crear/editar customers, firmar/convertir
contratos…; en PR2 además crear/editar units con `units:write` y reintentar
comunicaciones con `communications:send`) y `manager` pierde lo que el catálogo le
excluye (p. ej. `customers:delete`, que es solo `owner`). Los `DELETE` de
leads/tasks/incidents usan `recurso:manage` (owner+manager). Mapeo PR2: facilities
y floors → `facilities:read|manage`; unit-types → `units:read|manage` (config
estructural, owner+manager); units → `units:read`, write/change-status
`units:write`, delete `units:manage`; products (catálogo) → `products:read|manage`;
stock y ventas → `products:read|write`; communications → `communications:read|send`;
message-templates → `templates:read|manage`; automations → `automations:read|manage`.
**PR3** migra **billing/pagos/accesos** (payments, payment-methods, redsys,
invoice-series, tenant-aeat-credentials, verifactu-aeat, holded, access-credentials,
access-devices) con el principio **configuración (owner) vs operación
(manager/staff)**: cobros y métodos de pago → `payments:read`/`payments:charge`
(`staff` gana cobrar facturas, registrar/borrar métodos de pago y el redirect de
Redsys); configuración de integraciones (series, PUT de Holded/Redsys, upload/revoke
de credenciales AEAT) → `billing:configure` (owner-only, `manager` pierde crear/editar
series); operaciones y lecturas de billing (resend/refresh AEAT + GET de credenciales AEAT
history/me, Holded test/backfill/sync y la revisión `GET /settings/holded/review` + `POST /settings/holded/review/{invoices|payments}/:id {action: retry|already_in_holded|reviewed, holdedDocumentId?}`) → `invoices:manage` (owner+manager; `GET /settings/holded/series`,
que lista las series de la cuenta de Holded para elegirlas, → `billing:configure`; `GET/POST /settings/saas-billing/billing-details`, datos fiscales del tenant para sus facturas de suscripción, → `billing:configure`; `GET /admin/platform-billing/accountant-export?from=&to=&format=json|csv|xlsx&kind=invoices|payments`, exportación para la asesoría, → super admin `@RequireSuperadmin`; `GET/PUT /admin/platform-billing/holded` + `/holded/series`, `/holded/test`, `/holded/backfill`, copia en Holded de las facturas de suscripción, → super admin; `POST /admin/platform-invoices/:id/rectify`, rectificativa de una factura de suscripción, → super admin); lecturas
de settings de pasarela (GET de Holded/Redsys) → `settings:read`; accesos →
`access:read` (GET + device ping) y `access:manage`
(mutaciones de credenciales y devices, owner+manager; `staff` no gestiona accesos).
**PR4** cierra la migración con **admin/settings** (users, tenant-settings,
invitations, tenant-roles, billing-saas, integrations, rgpd, imports, reports) y
**retira `@Roles` de todos los controllers de tenant**: gestión de usuarios e
invitaciones → `users:read` (lecturas) + `users:manage` (editar/desactivar/transferir/
invitar, owner-only → `manager` pierde la gestión de usuarios); settings del tenant →
`settings:read`/`settings:manage`/`billing:configure`; roles custom → `settings:manage`;
suscripción SaaS → `billing:configure`; API keys + webhooks → `integrations:manage`
(owner-only → `manager` pierde); RGPD → `rgpd:manage` (owner-only → `manager` pierde);
importación CSV → nuevo permiso `imports:manage` (owner+manager); reports →
`reports:read` (lecturas) + `reports:run` (`staff` gana ejecutar informes). Los
endpoints `/me` (perfil propio) siguen sin permiso (self-service autenticado). Con esto
la autorización de toda la API la decide `@RequirePermission` + el catálogo, y los roles
personalizados por tenant controlan la app completa.

#### Roles personalizados por tenant (RBAC v1)

El `owner` puede definir roles a medida (`tenant_roles`) con un conjunto de
permisos + un `baseRole` enum de respaldo, y asignarlos a usuarios. Los permisos
efectivos de un usuario (rol custom si lo tiene, si no el enum) viajan en el
access JWT y los devuelve `/auth/me` en `permissions`. Editar/asignar un rol
aplica al siguiente refresh del access token (≤15 min).

| Metodo | Ruta                                  | Auth | Role  | Descripcion                                                      |
| ------ | ------------------------------------- | ---- | ----- | ---------------------------------------------------------------- |
| GET    | `/settings/roles`                     | SI   | owner | Lista los roles custom (con `userCount`)                         |
| POST   | `/settings/roles`                     | SI   | owner | Crea rol `{name, description?, permissions[], baseRole}`         |
| PATCH  | `/settings/roles/:id`                 | SI   | owner | Actualiza un rol (parcial)                                       |
| DELETE | `/settings/roles/:id`                 | SI   | owner | Borra el rol (los usuarios vuelven a su rol enum)                |
| PATCH  | `/settings/users/:userId/tenant-role` | SI   | owner | Asigna/quita rol custom `{tenantRoleId: uuid\|null}`             |
| PATCH  | `/settings/users/:userId/facilities`  | SI   | owner | Permisos por local: fija `{facilityIds: uuid[]}` ([] = ve todos) |

#### Permisos por local (facility scope)

Un usuario con locales asignados en `user_facilities` solo ve/gestiona las
entidades ancladas a esos locales. Sin asignaciones = sin restricción. El scope
viaja en el access JWT (`facilityScope`) y lo devuelve `/auth/me`; aplica al
siguiente refresh. **Filtrado por scope**: `GET /facilities`, `/units`,
`/contracts`, `/reservations`, `/analytics/occupancy`, `/access/devices`.
**Guards de escritura** (403 `facility_not_in_scope`): crear unit/contract/device
en un local fuera del scope, y mutar un local (`PATCH/DELETE /facilities/:id`,
imágenes) fuera del scope.

## Users

Modulo `apps/api/src/modules/users/`. Gestiona el equipo del tenant: los
miembros se crean **solo via invitacion** (no hay `POST /users`).

### Permisos

`RolesGuard` reads metadata `@Roles(...)` y se aplica como tercer guard
global (`Throttler → JwtAuth → Roles`). Reglas:

- Solo `owner` y `manager` pueden listar/editar/desactivar usuarios.
- Solo `owner` puede transferir la propiedad.
- Solo `owner` puede asignar el rol `manager` (un `manager` no puede
  promocionar a otro). Devuelve `403` con `code: insufficient_role`.
- No se puede cambiar el rol del `owner` ni desactivarlo. Devuelve
  `403` con `code: owner_required`. Para cambiar de owner hay que usar
  `transfer-ownership`, que intercambia los roles de forma atomica en
  una sola transaccion (`owner ↔ target`).

### Endpoints

| Metodo | Ruta                            | Auth | Roles          | Descripcion                                               |
| ------ | ------------------------------- | ---- | -------------- | --------------------------------------------------------- |
| GET    | `/users`                        | SI   | owner, manager | Lista todos los users del tenant                          |
| GET    | `/users/:id`                    | SI   | owner, manager | Detalle de un user                                        |
| PATCH  | `/users/:id`                    | SI   | owner, manager | Actualiza `fullName`, `phone`, `role`, `isActive`         |
| DELETE | `/users/:id`                    | SI   | owner, manager | Soft delete (isActive=false) + revoca sesiones del user   |
| POST   | `/users/:id/transfer-ownership` | SI   | owner          | Intercambia roles owner ↔ target. `204 No Content`.       |
| GET    | `/me`                           | SI   | cualquiera     | Alias de `/auth/me` proximo (de momento devuelve el user) |
| PATCH  | `/me`                           | SI   | cualquiera     | Actualiza el propio perfil (`fullName`, `phone`)          |
| POST   | `/me/change-password`           | SI   | cualquiera     | Cambia la propia password. Revoca las **otras** sesiones  |

`PATCH /me/change-password` mantiene la sesion del refresh cookie en
curso (la identifica parseando el cookie y extrayendo el `sessionId`).
Las demas sesiones se revocan con `revokedReason: 'password_changed'`.
Devuelve `204 No Content` en exito, o `403` con `code: wrong_current_password`
si la `currentPassword` no coincide.

## Invitations

Modulo `apps/api/src/modules/invitations/`. Las invitaciones son la
**unica** via para crear nuevos users.

### Modelo de token

Token opaco con formato `<invitationId>.<secret>`:

- `invitationId`: UUID v7 de la fila en `invitations`.
- `secret`: 32 bytes random base64url. Solo el hash argon2id se persiste
  en `invitations.token_hash`.
- TTL: 7 dias desde la creacion (`expires_at`).
- **Single-use atomico**: el `markAccepted` usa `updateMany` con un
  `WHERE accepted_at IS NULL AND revoked_at IS NULL` para evitar carreras.

Indice unico parcial sobre `(tenant_id, email)` filtrado a
`accepted_at IS NULL AND revoked_at IS NULL`: no permite dos invitaciones
pendientes para el mismo email en un mismo tenant.

### Endpoints

| Metodo | Ruta                               | Auth | Roles                    | Descripcion                                              |
| ------ | ---------------------------------- | ---- | ------------------------ | -------------------------------------------------------- |
| GET    | `/invitations`                     | SI   | owner, manager           | Lista las invitaciones del tenant                        |
| POST   | `/invitations`                     | SI   | owner, manager           | Crea una invitacion + envia email                        |
| POST   | `/invitations/:id/revoke`          | SI   | owner, manager           | Revoca una invitacion pendiente. `204 No Content`.       |
| POST   | `/invitations/:id/resend`          | SI   | owner, manager           | Revoca la actual y crea una nueva con token nuevo        |
| GET    | `/invitations/token/:token`        | NO   | publico                  | Devuelve la informacion publica para mostrar la pantalla |
| POST   | `/invitations/token/:token/accept` | NO   | publico (throttle login) | Crea el user, marca la invitacion aceptada, emite sesion |

#### POST `/invitations`

**Body:**

```json
{
  "email": "jane@acme.com",
  "role": "manager",
  "fullName": "Jane Doe"
}
```

- `role`: `manager`, `staff` o `readonly` (no se puede invitar `owner`).
- `fullName` opcional; si se omite, el invitado lo introduce al aceptar.
- Solo `owner` puede invitar a otro `manager`. Un `manager` que intenta
  asignar `manager` recibe `403 { code: insufficient_role }`.

**Respuestas:**

- `201 Created` + body `InvitationDto`.
- `409 Conflict` con `code: email_already_user` si el email ya pertenece
  a un user del tenant.
- `409 Conflict` con `code: invitation_pending` si ya hay una invitacion
  pendiente para ese email.

#### POST `/invitations/token/:token/accept`

**Body:** `{ fullName, password }`.

- Crea el user con `emailVerifiedAt = now()` (aceptar = email verificado).
- Marca la invitacion `accepted_at = now()` atomicamente.
- Emite cookie `refresh_token` + access JWT y devuelve el mismo cuerpo
  que `register/login`.
- Si el token no existe, esta revocado o caducado: `404 Not Found`.

#### POST `/invitations/:id/resend`

Crea una nueva fila en `invitations` con un token nuevo y marca la
original como revocada con `revokedReason: 'replaced_by_resend'`.
Devuelve `201 Created` con el nuevo `InvitationDto` (no el original).
El token antiguo deja de funcionar inmediatamente.

## 2FA TOTP

Modulo `apps/api/src/modules/two-factor/`. Activacion opt-in por user. El
secret TOTP se cifra con AES-256-GCM (`MASTER_ENCRYPTION_KEY`) antes de
persistirse; los recovery codes se guardan con hash argon2id.

### Flujo de enrolment

1. `POST /auth/2fa/setup` (autenticado) — genera secret nuevo, lo cifra y
   guarda en `users.two_factor_pending_secret`. Devuelve:

   ```json
   {
     "otpauthUri": "otpauth://totp/TrasterOS:jane%40acme.com?...",
     "secretBase32": "JBSWY3DPEHPK3PXP"
   }
   ```

   El frontend renderiza el QR desde el URI; el `secretBase32` permite
   introducir el secret manualmente si el QR no es escaneable.

2. `POST /auth/2fa/verify` — body `{ "code": "123456" }` (6 digitos).
   Verifica el codigo contra el pending secret, mueve `pending` ->
   `two_factor_secret` cifrado, marca `two_factor_enabled = true` y emite
   10 recovery codes en plaintext **una sola vez**:

   ```json
   { "recoveryCodes": ["A1B2-C3D4", "F5G6-H7J8", ...] }
   ```

   El frontend debe mostrarlos al user y permitirle copiar/descargar.

### Login con 2FA

Si `user.two_factor_enabled = true`, `POST /auth/login` no emite tokens.
Devuelve:

```json
{
  "requires2fa": true,
  "pendingToken": "eyJ...",
  "expiresIn": 300
}
```

`pendingToken` es un JWT corto firmado con `JWT_2FA_PENDING_SECRET` (NO
con el access secret). Payload `{ sub, tenantId, purpose: '2fa_pending' }`,
TTL `JWT_2FA_PENDING_TTL_SECONDS` (default 300s).

El frontend debe llamar a:

`POST /auth/2fa/challenge` — body `{ pendingToken, code?, recoveryCode? }`.
Uno de los dos campos es obligatorio. En exito devuelve la respuesta
estandar de login (cookie `refresh_token` + `accessToken` + `user/tenant/subscription`).

### Endpoints

| Metodo | Ruta                                  | Auth | Throttle  | Descripcion                                                      |
| ------ | ------------------------------------- | ---- | --------- | ---------------------------------------------------------------- |
| GET    | `/auth/2fa/status`                    | SI   | 60/min/IP | `{ enabled, enrolledAt, recoveryCodesRemaining }`                |
| POST   | `/auth/2fa/setup`                     | SI   | 60/min/IP | Genera secret + URI; aun no activa 2FA                           |
| POST   | `/auth/2fa/verify`                    | SI   | 60/min/IP | Activa 2FA con el primer codigo; emite recovery codes            |
| POST   | `/auth/2fa/disable`                   | SI   | 5/min/IP  | Requiere `currentPassword` + (`code` o `recoveryCode`)           |
| POST   | `/auth/2fa/recovery-codes/regenerate` | SI   | 60/min/IP | Requiere `currentPassword` + `code`; invalida los anteriores     |
| POST   | `/auth/2fa/challenge`                 | NO   | 5/min/IP  | Recibe `pendingToken` + `code` o `recoveryCode`; emite la sesion |

### Codigos `code` (en respuestas 403/400)

| `code`                   | Cuando                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `already_enabled`        | `setup`/`verify` con 2FA ya activo.                                                                                      |
| `setup_required`         | `verify` sin haber llamado a `setup` antes.                                                                              |
| `not_enabled`            | `disable`/`regenerate` con 2FA apagado.                                                                                  |
| `wrong_current_password` | `disable`/`regenerate` con password incorrecta.                                                                          |
| `invalid_code`           | Codigo TOTP o recovery invalido en cualquier flujo. Tambien un TOTP **ya usado** en un login anterior (anti-replay).     |
| `too_many_2fa_attempts`  | **429** en el challenge tras 5 fallos en 15 min del mismo usuario (tenant o super admin), aunque el codigo sea correcto. |

### Recovery codes

Generados al activar 2FA o al llamar a `recovery-codes/regenerate`:

- 10 codigos por user, formato `XXXX-XXXX` (alfabeto `[A-HJ-NP-Z2-9]`,
  excluye ambiguos `I/O/0/1`).
- Hash argon2id en BD, plaintext devuelto al user **una vez** (no se puede
  volver a recuperar; si los pierde, debe regenerarlos).
- Single-use: al consumir uno, se marca `used_at` con un `updateMany`
  atomico (`WHERE id = $1 AND used_at IS NULL`).
- Regenerar borra todos los codigos previos en una transaccion.

## Facilities, unit types y units (Fase 2)

Modulo `apps/api/src/modules/facilities/`. Cubre el modelo fisico:
locales (`facilities`), plantas (`facility_floors`), tipologias de trastero
(`unit_types`, a nivel de tenant) y trasteros individuales (`units`).

### Invariantes de dominio

- `unit_types` son **por tenant**, no por facility — pensados para
  empresas con varios locales que ofrecen tamaños estandar (S/M/L/XL).
- `facility_floors` son **opcionales**: al crear el primer `unit` sin
  `floorId`, el servicio crea una "Planta principal" virtual con
  `isDefault = true`.
- `units.area_m2` y `units.volume_m3` son **columnas GENERATED ALWAYS AS
  ... STORED** en Postgres. Prisma las lee pero no las escribe — calcular
  area/volumen desde la app es imposible.
- `units.status = 'occupied'` solo puede asignarlo el flujo de contratos
  (Fase 3). El endpoint manual de change-status rechaza con `400
occupied_via_contract_only`.
- `UNIQUE (facility_id, code)` en `units` — codigo unico dentro del local.
- Borrar un `unit_type` con units asociadas lo **desactiva**
  (`is_active = false`) en vez de borrarlo, para no romper la integridad.
- Soft delete en `facilities` (`deleted_at`).

### Transiciones de estado

```
available    -> reserved, maintenance, blocked
reserved     -> available, maintenance, blocked
maintenance  -> available, blocked
blocked      -> available, maintenance
occupied     -> available, maintenance, blocked   (solo via servicio interno; el flujo de contratos lo pondra automaticamente)
```

Cada cambio inserta una fila inmutable en `unit_status_history` con
`previous_status`, `new_status`, `changed_by_user_id` y `reason`.

### Endpoints

| Metodo | Ruta                          | Auth | Roles                 | Descripcion                                                                                      |
| ------ | ----------------------------- | ---- | --------------------- | ------------------------------------------------------------------------------------------------ |
| GET    | `/facilities`                 | SI   | cualquiera            | Lista facilities del tenant (no borradas)                                                        |
| GET    | `/facilities/:id`             | SI   | cualquiera            | Detalle con `unitsTotal` / `unitsOccupied`                                                       |
| POST   | `/facilities`                 | SI   | owner, manager        | Crea facility                                                                                    |
| PATCH  | `/facilities/:id`             | SI   | owner, manager        | Actualiza facility                                                                               |
| DELETE | `/facilities/:id`             | SI   | owner, manager        | Soft delete; 409 si queda algo pendiente (ver revisión de Locales)                               |
| GET    | `/facilities/:id/floors`      | SI   | cualquiera            | Lista plantas                                                                                    |
| POST   | `/facilities/:id/floors`      | SI   | owner, manager        | Crea planta                                                                                      |
| PATCH  | `/floors/:id`                 | SI   | owner, manager        | Renombra planta                                                                                  |
| DELETE | `/floors/:id`                 | SI   | owner, manager        | Borra planta (409 si tiene units o es default)                                                   |
| POST   | `/floors/:id/plan-upload-url` | SI   | owner, manager        | Devuelve signed URL PUT a MinIO + `publicUrl`                                                    |
| PATCH  | `/floors/:id/plan`            | SI   | owner, manager        | Persiste `plan_image_url`, `plan_width_px`, `plan_height_px`                                     |
| PATCH  | `/floors/:id/units-layout`    | SI   | owner, manager        | Actualiza coords (`plan_x/y/width/height`) de N units en tx                                      |
| GET    | `/unit-types`                 | SI   | cualquiera            | Lista tipos del tenant                                                                           |
| POST   | `/unit-types`                 | SI   | owner, manager        | Crea tipo (409 `unit_type_name_taken` si nombre duplicado)                                       |
| PATCH  | `/unit-types/:id`             | SI   | owner, manager        | Actualiza                                                                                        |
| DELETE | `/unit-types/:id`             | SI   | owner, manager        | Borra o desactiva si tiene units                                                                 |
| GET    | `/units`                      | SI   | cualquiera            | Lista con filtros `facilityId/floorId/unitTypeId/status/search/cursor/limit` (cursor pagination) |
| GET    | `/units/:id`                  | SI   | cualquiera            | Detalle                                                                                          |
| GET    | `/units/:id/history`          | SI   | cualquiera            | Historial de estados (desc)                                                                      |
| POST   | `/units`                      | SI   | owner, manager        | Crea unit (409 `unit_code_taken` si codigo duplicado)                                            |
| PATCH  | `/units/:id`                  | SI   | owner, manager        | Actualiza unit (no el status)                                                                    |
| POST   | `/units/:id/change-status`    | SI   | owner, manager, staff | Cambia status + inserta history                                                                  |
| DELETE | `/units/:id`                  | SI   | owner, manager        | Borra (409 `unit_occupied` si esta ocupada)                                                      |
| GET    | `/dashboard/occupancy`        | SI   | cualquiera            | Agregado: `totalUnits`, `byStatus`, `byFacility`, `byUnitType`                                   |

### Subida de planos a MinIO

Patron de signed URL PUT directo desde el navegador (la API no recibe el
archivo, solo gestiona la URL):

1. Cliente: `POST /floors/:id/plan-upload-url` con `{ mimeType, sizeBytes }`.
   Devuelve `{ uploadUrl, publicUrl, expiresIn, requiredHeaders }`.
2. Cliente: `PUT uploadUrl` con el body del archivo y los `requiredHeaders`
   (incluye `Content-Type`).
3. Cliente: tras 200 OK, carga la imagen en un `<img>` para conocer
   `naturalWidth/naturalHeight` y llama a `PATCH /floors/:id/plan` con
   `{ planImageUrl: publicUrl, planWidthPx, planHeightPx }`.

Bucket: `MINIO_BUCKET_PLANS` (default `storageos-plans`). Path:
`<tenantId>/<facilityId>/floors/<floorId>-<uuid>.<ext>`. Max 5 MB.
MIME types aceptados: `image/png`, `image/jpeg`, `image/webp`.

## Customers, contratos y reservas (Fase 3)

Modulo `apps/api/src/modules/{customers,contracts}/`. Gestion del flujo
de alquiler completo: clientes (`customers`), documentos
(`customer_documents`), contratos (`contracts` con state machine), eventos
inmutables (`contract_events`) y reservas previas (`reservations`).

### Invariantes y patrones clave

- **Pricing snapshot**: `contracts.priceMonthly` se congela al firmar.
  Cambios solo via `POST /contracts/:id/change-price` con motivo. Cada
  cambio genera un evento `contract_events.price_changed` con `{ from, to,
reason }`.
- **State machine** del contrato:
  ```
  draft -> active     (POST /sign)         → unit.status = occupied
  active -> ending    (POST /request-end)
  active|ending -> ended    (POST /end)    → unit.status = available
  draft -> cancelled
  active|ending -> cancelled (POST /cancel) → unit.status = available
  ```
  Transiciones invalidas devuelven `400 invalid_contract_transition`.
- **Numero de contrato**: secuencial por tenant, formato `CT-{year}-{NNNNN}`.
- **EXCLUDE constraint** en `reservations`: imposible insertar dos reservas
  `pending`/`confirmed` solapando el mismo unit. La regla vive en el schema
  (extension `btree_gist` + columna generada `time_range tstzrange`). Patron
  heredado de [Asucar-Reservas](https://github.com/dignitasjota/asucar-reservas).
- **Customer soft delete**: `deleted_at` preserva el historial de contratos
  y reservas para auditoria y RGPD.
- **PDF de contrato**: Puppeteer headless sincrono dentro del request.
  Dynamic import (`await import('puppeteer')`) por ser ESM-only y evitar
  conflicto con Jest CJS. PDF subido a MinIO bucket `uploads` con clave
  `<tenantId>/contracts/<contractId>-<uuid>.pdf` y persistido en
  `contracts.signed_pdf_url`. Mover a BullMQ en Fase 4.

### Endpoints — Customers

| Metodo | Ruta                                  | Auth | Roles                 | Descripcion                                                                                                                                      |
| ------ | ------------------------------------- | ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/customers`                          | SI   | cualquiera            | Lista con `?search=` por nombre/email/doc                                                                                                        |
| GET    | `/customers/:id`                      | SI   | cualquiera            | Detalle + counts (activeContracts/pendingReservations)                                                                                           |
| GET    | `/customers/overview`                 | SI   | `customers:read`      | Una fila por inquilino: trasteros, cuota/mes, cómo paga, deuda vencida y desde cuándo, seguro, contrato, último contacto y siguiente seguimiento |
| GET    | `/customers/:id/account`              | SI   | `customers:read`      | Estado de cuenta: cuota por contrato, método de cobro, próxima factura, deuda con los pasos del escalado, pagado en 12 meses                     |
| POST   | `/customers`                          | SI   | owner, manager, staff | Crea customer (individual o business)                                                                                                            |
| PATCH  | `/customers/:id`                      | SI   | owner, manager, staff | Actualiza                                                                                                                                        |
| DELETE | `/customers/:id`                      | SI   | owner, manager        | Soft delete                                                                                                                                      |
| POST   | `/customers/:id/kyc`                  | SI   | owner, manager        | Marca/desmarca KYC verificado                                                                                                                    |
| GET    | `/customers/:id/documents`            | SI   | cualquiera            | Lista documentos                                                                                                                                 |
| POST   | `/customers/:id/documents/upload-url` | SI   | owner, manager, staff | Signed URL PUT para MinIO                                                                                                                        |
| POST   | `/customers/:id/documents`            | SI   | owner, manager, staff | Registra el documento tras subirlo                                                                                                               |
| DELETE | `/documents/:id`                      | SI   | owner, manager        | Borra documento                                                                                                                                  |

### Endpoints — Contracts

| Metodo | Ruta                                          | Auth | Roles                 | Descripcion                                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------- | ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/contracts`                                  | SI   | cualquiera            | Filtros `?status=&customerId=&facilityId=&unitId=`                                                                                                                                                                                                                          |
| GET    | `/contracts/:id`                              | SI   | cualquiera            | Detalle con `effectivePrice` calculado                                                                                                                                                                                                                                      |
| GET    | `/contracts/:id/events`                       | SI   | cualquiera            | Timeline inmutable de eventos                                                                                                                                                                                                                                               |
| POST   | `/contracts`                                  | SI   | owner, manager, staff | Crea borrador                                                                                                                                                                                                                                                               |
| PATCH  | `/contracts/:id`                              | SI   | owner, manager, staff | Edita campos meta (no precio)                                                                                                                                                                                                                                               |
| POST   | `/contracts/:id/sign`                         | SI   | owner, manager        | Pasa a active + ocupa unit                                                                                                                                                                                                                                                  |
| POST   | `/contracts/:id/request-end`                  | SI   | owner, manager        | Pasa a ending con `{endDate?}` (último día; sin ella, la primera fecha posible: hoy + preaviso, llevada a final de mes si el negocio tiene `moveOutEndOfMonth`). El día siguiente se finaliza solo si el tenant tiene `autoEndContracts` (cron `contracts.auto-end`)        |
| POST   | `/contracts/:id/end`                          | SI   | owner, manager        | Pasa a ended + libera unit. Si el contrato es de **prepago** (semestral/anual), genera una rectificativa R1 en **borrador** que abona los meses completos no consumidos de la factura pagada que cubre la fecha de baja (el staff la emite y reembolsa a mano; idempotente) |
| POST   | `/contracts/:id/cancel`                       | SI   | owner, manager        | Cancela + libera unit                                                                                                                                                                                                                                                       |
| POST   | `/contracts/:id/change-price`                 | SI   | owner, manager        | Cambia precio con motivo (registrado en eventos)                                                                                                                                                                                                                            |
| POST   | `/contracts/:id/notes`                        | SI   | owner, manager, staff | Anyade nota a la timeline                                                                                                                                                                                                                                                   |
| POST   | `/contracts/:id/generate-pdf`                 | SI   | owner, manager        | Genera PDF con Puppeteer                                                                                                                                                                                                                                                    |
| GET    | `/contracts/:id/inspection-photos?kind=`      | SI   | `contracts:read`      | Fotos de inspección (check-in/check-out) con URL firmada GET; filtra por `kind`                                                                                                                                                                                             |
| POST   | `/contracts/:id/inspection-photos/upload-url` | SI   | `contracts:write`     | Signed URL PUT a MinIO (bucket privado `uploads`); body `{kind, mimeType, fileName}`                                                                                                                                                                                        |
| POST   | `/contracts/:id/inspection-photos`            | SI   | `contracts:write`     | Registra la foto `{kind, key, note?}`; 400 `invalid_photo_key` si la key no es del contrato+kind                                                                                                                                                                            |
| DELETE | `/contracts/:id/inspection-photos/:photoId`   | SI   | `contracts:write`     | Borra una foto de inspección                                                                                                                                                                                                                                                |

Inquilinos, mejoras (2026-11-05): `GET /customers/:id/merge-preview?sourceId=`, `POST /customers/:id/merge {sourceId}` (`customers:delete`; 400 `same_customer`, 409 `merge_test_customer`), `GET /customers/:id/timeline`, `GET /customers/:id/insights`, `POST /customers/:id/message {channel, templateId?, subject?, bodyText?}` (`communications:send`), `GET/POST /customers/:id/contacts`, `PATCH/DELETE /customers/:id/contacts/:contactId`, `GET/POST /customers/:id/document-requests` (409 `document_already_requested`), `DELETE …/:requestId`, `GET /portal/me/document-requests`, `GET/POST /customers/views`, `DELETE /customers/views/:viewId`, `GET /customers/deleted`, `POST /customers/:id/restore` (409 `customer_not_restorable`), `POST /customers/bulk/tags`, `POST /customers/bulk/message`, `POST /invoices/bulk/remind-customers`. El segmento de campañas admite `customerIds`.

Inquilinos (2026-11-05): `GET /customers/duplicates?email=&phone=&documentNumber=&excludeId=` (solo avisa), `GET /customers/:customerId/documents/:id/download` (dirección firmada), `POST /customers/bulk/portal-access {customerIds}` (hasta 100). `DELETE /customers/:id`: 409 `customer_has_reservations` y 409 `customer_has_debt` con `details.amount`, salvo `?confirmDebt=1`. `POST`/`PATCH /customers`: 400 `invalid_tax_id` si el tipo es DNI, NIE o CIF, y 400 `customer_name_required` al editar. Las rutas de un inquilino dan 404 fuera del alcance por local (`CustomerScopeGuard`). `GET /customers/:id/account` exige además `invoices:read` y `payments:read`; sin ellos, `/customers/overview` llega con las cifras a 0 y `moneyVisible: false`.

`POST /contracts` admite `reservationId` (convierte esa reserva: mismo trastero e inquilino; 400 `reservation_not_convertible`/`reservation_mismatch`) y responde 400 `invalid_end_date`/`discount_too_high`. `PATCH /contracts/:id`: 400 `contract_closed`, `ending_requires_date`, `promotion_price_locked`. Firmar o trasladar sobre un trastero retenido por otro inquilino: 409 `unit_reserved_for_other`. `POST /contracts/:id/settle-deposit`: 400 `deposit_not_collected`. `ContractDto.depositCollected` dice si la fianza se cobró de verdad.

Mejoras (2026-11-05): `GET /contracts/page?view=unsigned|first_payment|ending|expiring` (cada fila con `pendingAmount`), `GET /contracts/:id/account`, `GET /contracts/:id/move-out`, `POST /contracts/bulk/request-signature {contractIds}`. `POST /contracts/:id/change-price` admite `effectiveDate` y `notifyCustomer` (fecha futura = programado; `DELETE /contracts/:id/scheduled-price` lo anula). `POST /contracts/:id/change-unit` admite `effectiveDate` (reserva el destino; `DELETE /contracts/:id/scheduled-move`; 409 `move_already_scheduled`); también `POST /unit-change-requests/:id/move`. `POST /contracts/:id/renew` admite `newPrice` y `expectedEndDate` (409 `contract_changed` si el fin ya cambió; 400 `contract_indefinite` sin fecha de fin; 409 `price_change_pending` con otro cambio de cuota en marcha; con cuota nueva sale un solo correo). `POST /contracts/:id/settle-deposit` admite `applyToInvoices`, `returnMethod`, `returnedOn`, `returnReference` y `notifyCustomer`. `POST /contracts` admite `waitlistEntryId`. Reserva pública: `holdToken` en `POST /public/move-in/book/:slug` y `…/quote`, y `?hold=` en `…/availability`.

### Endpoints — Reservations

| Metodo | Ruta                                    | Auth | Roles                 | Descripcion                                        |
| ------ | --------------------------------------- | ---- | --------------------- | -------------------------------------------------- |
| GET    | `/reservations`                         | SI   | cualquiera            | Filtros `?unitId=&customerId=&status=&facilityId=` |
| GET    | `/reservations/:id`                     | SI   | cualquiera            | Detalle                                            |
| POST   | `/reservations`                         | SI   | owner, manager, staff | Crea reserva (409 si overlap)                      |
| POST   | `/reservations/:id/confirm`             | SI   | owner, manager, staff | Pasa a confirmed + unit.status = reserved          |
| POST   | `/reservations/:id/cancel`              | SI   | owner, manager, staff | Cancela + libera unit si era ultima activa         |
| POST   | `/reservations/:id/convert-to-contract` | SI   | owner, manager        | Crea contrato draft y marca reserva converted      |

### Codigos `code` (Fase 3)

| `code`                           | Cuando                                                 |
| -------------------------------- | ------------------------------------------------------ |
| `customer_not_found`             | Customer ID invalido o ya borrado.                     |
| `document_not_found`             | Document ID invalido.                                  |
| `contract_not_found`             | Contract ID invalido.                                  |
| `reservation_not_found`          | Reservation ID invalido.                               |
| `invalid_contract_transition`    | Transicion no permitida en la state machine.           |
| `contract_not_active`            | Cambio de precio sobre contrato no `active`/`ending`.  |
| `unit_not_available`             | Sign sobre unit que no esta `available`/`reserved`.    |
| `reservation_overlap`            | EXCLUDE constraint impide la reserva por solapamiento. |
| `reservation_not_convertible`    | Convertir reserva ya cancelada/caducada/convertida.    |
| `invalid_reservation_transition` | Transicion no permitida en reservation state machine.  |
| `customer_required`              | Convertir reserva sin customer en reserva ni en input. |

## Facturacion, pagos, dunning, RGPD y portal (Fase 4)

Modulos `apps/api/src/modules/{billing,payments,dunning,rgpd,portal}/`.
Cubre el ciclo completo de facturacion recurrente (Verifactu ready),
cobro automatico con Stripe, gestion de impagos via dunning, derechos
RGPD compatibles con la obligacion fiscal de conservar facturas, y
portal mínimo para que el inquilino consulte sus facturas.

### Invariantes clave

- **Numeracion secuencial atomic**: `invoice_series.next_number` se
  incrementa con un `UPDATE ... RETURNING` en la misma `$transaction`
  donde se INSERT del invoice. UNIQUE `(tenantId, seriesId, sequenceNumber)`.
- **Verifactu hash encadenado** SHA-256 sobre
  `${tenantTaxId}|${invoiceNumber}|${issueDate}|${total}|${previousHash ?? ''}`.
  `previous_hash` apunta a la inmediatamente anterior emitida de la
  misma serie del tenant. Inmutable tras `issue`.
- **State machine de invoices**: `draft → issued → paid/overdue/cancelled/refunded/partially_refunded`.
  Transiciones invalidas devuelven `400 invalid_invoice_transition`.
- **Stripe gateway**: tokens cifrados con `CryptoService` (AES-256-GCM,
  ADR-007). Charges off-session. Webhook publico con verificacion HMAC.
- **AEAT_MODE**: `stub` (Fase 4), `sandbox` o `production` (Fase 8).
  Variable env que gobierna si el envio a AEAT es real o simulado.
- **Anonimizacion RGPD**: sustituye datos personales por `*** ANONIMIZADO ***`
  - borra `customer_documents` y `payment_methods`. **NO borra invoices**:
    la obligacion fiscal de Ley 58/2003 + RD 1007/2023 obliga a conservarlas
    4-6 años. Bloquea anonimizar si hay contratos activos.

### Endpoints — Invoice series

| Metodo | Ruta                  | Auth | Roles          | Descripcion                                     |
| ------ | --------------------- | ---- | -------------- | ----------------------------------------------- |
| GET    | `/invoice-series`     | SI   | cualquiera     | Lista series del tenant                         |
| POST   | `/invoice-series`     | SI   | owner, manager | Crea serie (409 `invoice_series_code_taken`)    |
| PATCH  | `/invoice-series/:id` | SI   | owner, manager | Actualiza (nombre, prefix, isDefault, isActive) |

### Endpoints — Invoices

| Metodo | Ruta                           | Auth | Roles                 | Descripcion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------ | ---- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/invoices`                    | SI   | cualquiera            | Filtros `?status=&customerId=&contractId=&overdue=true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/invoices/:id`                | SI   | cualquiera            | Detalle con items, hash, qrCodeUrl                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/invoices`                    | SI   | owner, manager, staff | Crea borrador con items                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PATCH  | `/invoices/:id`                | SI   | owner, manager, staff | Edita (lineas solo en draft)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/invoices/:id/issue`          | SI   | owner, manager        | Asigna numero + hash + QR; envia AEAT (stub/real)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/invoices/:id/cancel`         | SI   | owner, manager        | Borrador → `cancelled`. Emitida sin cobros → `rectified` + rectificativa de abono por el total, emitida y compensada (400 `invoice_has_payments` / `invoice_not_cancellable`; 409 con cobro en curso o en remesa)                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/invoices/:id/void`           | SI   | owner, manager        | `{reason}` (≥5). Anula una factura **emitida por error** (de prueba, duplicada, de una operación que no existió): `cancelled` + `voidedAt`/`voidReason`, fuera de libros e informes, PDF con «ANULADA» y, con Veri\*Factu, registro de anulación. Solo F1/F2 emitidas o vencidas, sin cobros ni rectificativas: 400 `invoice_not_voidable`, `invoice_has_payments`, `invoice_rectified`, `not_an_invoice`, `issued_by_holded`; 409 `payment_in_progress`, `invoice_in_sepa_remittance`, `verifactu_record_pending` (su registro aún sin respuesta). Devuelve lo consumido y anula el recargo sin cobrar, como `cancel` |
| POST   | `/invoices/:id/refund`         | SI   | owner, manager        | Reembolso parcial o total                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/invoices/:id/mark-paid`      | SI   | owner, manager, staff | Pago manual (efectivo, transferencia, tarjeta)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/invoices/:id/generate-pdf`   | SI   | owner, manager        | Genera PDF con QR Verifactu y persiste signed_pdf_url                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/invoices/jobs/run-recurring` | SI   | owner, manager        | Dispara manualmente el job de facturas recurrentes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Revisión de Facturas (2026-11-07)

| Metodo    | Ruta                                                         | Permiso                               | Qué cambia                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET       | `/invoices/:id/late-fee-preview`                             | `invoices:manage`                     | Nuevo. Cuánto sería el recargo por mora → `LateFeePreviewDto {amount, type, value}`. Mismos errores que aplicarlo                                                                                                                                                  |
| GET       | `/invoices` · `/invoices/page`                               | `invoices:read`                       | `?status=` desconocido → 400 `invalid_status`; ids de los filtros validados. `overdue=true` incluye las emitidas con el vencimiento pasado. Búsqueda por palabras                                                                                                  |
| POST      | `/invoices`                                                  | `invoices:write`                      | Respeta el alcance por local y el de inquilinos. Contrato de otro inquilino → 400 `contract_customer_mismatch`; borrado → 404 `contract_not_found`                                                                                                                 |
| PATCH     | `/invoices/:id`                                              | `invoices:write`                      | Cambiar el vencimiento de una emitida exige `dueDateReason` (400 `due_date_reason_required`); anterior a la emisión → 400 `due_date_before_issue`. Si la nueva fecha es de hoy en adelante, la vencida vuelve a emitida y se cancelan sus recordatorios pendientes |
| POST      | `/invoices/:id/issue`                                        | `invoices:manage`                     | Sin razón social, NIF y domicilio fiscal del emisor → 400 `issuer_fiscal_data_required` (`details.missing`, y `ownerId` si es de un propietario). Total 0 → queda pagada. El PDF se genera en el worker                                                            |
| POST      | `/invoices/:id/cancel`                                       | `invoices:manage`                     | Anular una emitida devuelve lo consumido (mes gratis, saldo de la señal, recompensa de referido) y anula su recargo por mora sin cobrar                                                                                                                            |
| POST      | `/invoices/:id/mark-paid`                                    | `invoices:write`                      | El mismo cobro (importe y forma) dos veces en 30 s → 409 `duplicate_payment`. `paidAt` en el futuro → 400 `paid_at_in_future`                                                                                                                                      |
| POST      | `/invoices/:id/refund`                                       | `invoices:refund`                     | Cobro con el TPV del banco → 400 `refund_needs_bank`; con `registeredExternally: true` se registra la devolución hecha en el banco. Doble envío → 409 `duplicate_refund`. Cada devolución queda en `invoice_refunds`                                               |
| POST      | `/invoices/:id/late-fee`                                     | `invoices:manage`                     | Solo sobre una vencida (400 `invoice_not_overdue`), no sobre otro recargo (400 `late_fee_on_late_fee`), con el recargo activado (400 `late_fee_disabled`)                                                                                                          |
| POST      | `/invoices/:id/generate-pdf`                                 | `invoices:manage`                     | Un borrador → 400 `invoice_is_draft`                                                                                                                                                                                                                               |
| POST      | `/invoices/bulk/issue`                                       | `invoices:manage`                     | Respeta el alcance por local. Cada fallo trae `message` e `invoiceNumber`                                                                                                                                                                                          |
| POST      | `/invoices/bulk/remind`                                      | `communications:send`                 | A quien ya recibió un recordatorio en 24 h no se le envía otro (`reminder_recently_sent` en `failed`). Antes de vencer sale «Tu factura vence pronto»                                                                                                              |
| POST      | `/payments/invoices/bulk/charge`                             | `payments:charge`                     | Devuelve `{succeeded, processing, failed}`: `processing` son los adeudos SEPA en curso; una tarjeta rechazada va a `failed` con su motivo                                                                                                                          |
| POST      | `/billing/invoices/:id/resend-aeat` · `/refresh-aeat-status` | `invoices:manage`                     | Respetan el alcance por local. Un justificante de fianza → 400 `not_an_invoice`                                                                                                                                                                                    |
| GET/PATCH | `/settings/tenant/billing`                                   | `settings:read` / `billing:configure` | Nuevo `invoiceDueDays` (0-120, 15 por defecto): días para pagar desde la emisión                                                                                                                                                                                   |

`InvoiceDto` gana `rectifiesInvoiceDate` y `amountCompensated` (lo saldado con un abono, que no es dinero cobrado); `amountPending` vale 0 en borradores, anuladas y pagadas. Importes de más de 999.999.999 € → 400 `amount_too_large`.

### Mejoras de Facturas (2026-11-07)

| Metodo   | Ruta                                             | Permiso               | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | `/invoices/page`                                 | `invoices:read`       | Filtros nuevos `from`/`to` (fecha de emisión, `AAAA-MM-DD`), `type` (`F1`, `F2`, `R`, `deposit`), `payment` (`card`, `sepa_debit`, `bank_transfer`, `cash`, `other` = cobradas así; `none` = pendientes sin forma de pago guardada) y `sort` (`newest`, `oldest`, `due`, `amount`). 400 `invalid_date`, `invalid_type`, `invalid_payment`, `invalid_sort`. Cada fila trae `collection {inFlight, inRemittance, inPaymentPlan, lastReminderAt}` |
| GET      | `/invoices/totals`                               | `invoices:read`       | Mismos filtros → `InvoiceTotalsDto {count, total, pending, collected}` (sin las canceladas; `collected` = dinero cobrado menos lo devuelto)                                                                                                                                                                                                                                                                                                    |
| GET/POST | `/invoices/views` · DELETE `/invoices/views/:id` | `invoices:read`       | Vistas de la lista del equipo `{name, filters}`. Con el mismo nombre se sustituye. Borrar → 204                                                                                                                                                                                                                                                                                                                                                |
| GET      | `/invoices/:id/activity`                         | `invoices:read`       | `InvoiceActivityDto`: cobros (`editable`, `undone`), devoluciones (con su vía), avisos enviados (también los recordatorios que la incluyen con otras), pasos del escalado e historial                                                                                                                                                                                                                                                          |
| POST     | `/invoices/:id/payments/:paymentId/undo`         | `invoices:write`      | `{reason}`. Deshace un cobro registrado a mano por error: la factura vuelve a pendiente. 400 `payment_not_editable` (pasarela, abono, retención o con devoluciones), 404 `payment_not_found`, 409 `cash_day_closed` si la caja de ese día ya se cerró. No cuenta como recibo devuelto                                                                                                                                                          |
| PATCH    | `/invoices/:id/payments/:paymentId`              | `invoices:write`      | `{paidAt?, methodType?}`: corrige la fecha o la forma de un cobro registrado a mano. 400 `paid_at_in_future`, 409 `cash_day_closed` (la fecha de antes o la nueva)                                                                                                                                                                                                                                                                             |
| POST     | `/invoices/:id/duplicate`                        | `invoices:write`      | Copia una F1 o F2 como borrador (mismo cliente, contrato, líneas y notas) → 201. Rectificativas y justificantes → 400 `cannot_duplicate`                                                                                                                                                                                                                                                                                                       |
| GET      | `/invoices/:id/cancel-preview`                   | `invoices:manage`     | Qué pasará al anular → `InvoiceCancelPreviewDto {action: cancel_draft\|cancel_receipt\|void\|blocked, blockedReason, creditNoteTotal, freeMonth, credit, referralReward, lateFee, accessRestored, periodic}`                                                                                                                                                                                                                                   |
| GET      | `/invoices/:id/refund-options`                   | `invoices:refund`     | Cómo se devolvería → `{refundable, how: gateway\|bank\|manual\|none, methodType, last4, creditAvailable}`                                                                                                                                                                                                                                                                                                                                      |
| POST     | `/invoices/:id/refund`                           | `invoices:refund`     | Nuevo `method: 'credit'`: no sale dinero, queda como saldo a favor del contrato (`ContractDto.creditBalance`) y se descuenta de su siguiente factura al emitirla. Sin contrato → 400 `credit_needs_contract`                                                                                                                                                                                                                                   |
| POST     | `/invoices/:id/send`                             | `communications:send` | `{email?}` (por defecto, el de facturación del inquilino o su email) → 200 `{recipient, communicationId}`. El correo lleva el enlace de descarga. Borrador o cancelada → 400 `invoice_not_sendable`; sin email → 400 `customer_email_missing`                                                                                                                                                                                                  |
| GET      | `/invoices/month-close?month=AAAA-MM`            | `invoices:read`       | `MonthCloseDto {missingContracts, drafts, pending, paidCount, issuerMissing}`; cada fila con `chargeable` y sus avisos (`no_email`, `no_payment_method`, `zero_total`, `contract_ending`, `no_tax_id`, `previous_debt`). 400 `invalid_month`                                                                                                                                                                                                   |
| POST     | `/invoices/month-close/generate`                 | `invoices:manage`     | `{month}` → 200 `{created}`: crea los borradores que faltan de ese mes (como la recurrente). Mes futuro → 400 `month_in_future`                                                                                                                                                                                                                                                                                                                |
| POST     | `/invoices/bulk/remind`                          | `communications:send` | Un solo correo por inquilino con todas sus facturas seleccionadas (origen `bulk.reminder_summary`)                                                                                                                                                                                                                                                                                                                                             |
| PATCH    | `/customers/:id`                                 | `customers:write`     | Nuevo `invoiceDueDays` (0-120 o `null` = el plazo del negocio): días para pagar sus facturas                                                                                                                                                                                                                                                                                                                                                   |
| GET      | `/v1/public/invoices/:token/pdf`                 | público               | Enlace del correo: redirige (302) al PDF firmado 5 minutos; lo genera si falta. Firma inválida, borrador o cancelada → 404 `invoice_not_found`. 30 por minuto                                                                                                                                                                                                                                                                                  |

El escalado de impagos también agrupa: si el mismo día tocan recordatorios de varias facturas del inquilino, sale un solo correo (`dunning.reminder_summary`) y las demás acciones quedan hechas con `result.mergedInto`. `PortalInvoiceDto.hasPdf` es `true` en toda factura emitida (el área de clientes lo genera al pedirlo).

### Reservas online: correos (2026-11-08)

- La primera factura de una reserva online (contrato con `firstPaymentDeadline`, desde la web o el área de clientes) no dispara `customer_email.invoice_issued` ni las automatizaciones de `invoice_issued` (se saltan con «reserva online pendiente de pago»). Llega con `customer_email.payment_received` al pagarla, con el enlace del PDF. Las demás facturas, igual que antes.
- Tipo nuevo en `GET/PATCH /settings/tenant/customer-emails`: `booking_expired` (activado por defecto). Lo envía `expireUnpaidBookings` al cancelar una reserva online sin pagar (evento `domain.booking_expired {tenantId, contractId, customerId}`), con un botón a la reserva online del negocio con el local y el tamaño elegidos (`/reservar` en el dominio propio o `/book/<slug>`).

### Endpoints — Payments

| Metodo | Ruta                             | Auth | Roles                 | Descripcion                                                                                                                                   |
| ------ | -------------------------------- | ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/payments`                      | SI   | cualquiera            | Lista con filtros `?invoiceId=&customerId=`                                                                                                   |
| POST   | `/payments/invoices/:id/charge`  | SI   | owner, manager        | Charge automatico (usa payment_method default si no hay paymentMethodId; un método de otro inquilino → 400 `payment_method_not_for_customer`) |
| GET    | `/customers/:id/payment-methods` | SI   | cualquiera            | Lista metodos guardados del customer                                                                                                          |
| POST   | `/payment-methods/setup-intent`  | SI   | owner, manager, staff | Crea Stripe SetupIntent + Customer si falta                                                                                                   |
| POST   | `/payment-methods`               | SI   | owner, manager, staff | Registra metodo tras setupIntent (cifra token)                                                                                                |
| DELETE | `/payment-methods/:id`           | SI   | owner, manager        | Soft delete                                                                                                                                   |
| POST   | `/webhooks/stripe`               | NO   | publico (HMAC)        | Eventos Stripe (raw body + Stripe-Signature)                                                                                                  |

### Endpoints — Dunning + RGPD

| Metodo | Ruta                            | Auth | Roles          | Descripcion                                                                      |
| ------ | ------------------------------- | ---- | -------------- | -------------------------------------------------------------------------------- |
| GET    | `/dunning`                      | SI   | cualquiera     | Lista acciones programadas/ejecutadas                                            |
| GET    | `/rgpd/requests`                | SI   | owner, manager | Lista solicitudes de derechos RGPD                                               |
| POST   | `/rgpd/requests`                | SI   | owner, manager | Crea solicitud (SLA 30 dias auto)                                                |
| PATCH  | `/rgpd/requests/:id`            | SI   | owner          | `{status, notes?}`: en curso, atendida o denegada (fija `fulfilledAt` al cerrar) |
| GET    | `/rgpd/customers/:id/export`    | SI   | owner, manager | Exporta JSON con todos los datos del customer                                    |
| POST   | `/rgpd/customers/:id/anonymize` | SI   | owner, manager | Anonimiza preservando invoices                                                   |

### Endpoints — Portal del cliente

| Metodo | Ruta                                      | Auth | Throttle  | Descripcion                                                                                                                                                                                                                                                                                                                                 |
| ------ | ----------------------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/portal/login/request`                   | NO   | 5/min/IP  | Envia magic link al email (204 silencioso)                                                                                                                                                                                                                                                                                                  |
| POST   | `/portal/login/consume`                   | NO   | 5/min/IP  | Intercambia token por JWT corto (single-use)                                                                                                                                                                                                                                                                                                |
| GET    | `/portal/me/invoices`                     | NO   | 60/min/IP | Bearer JWT portal; lista facturas del cliente                                                                                                                                                                                                                                                                                               |
| GET    | `/portal/me/payment-methods`              | NO   | 60/min/IP | Bearer JWT portal; lista metodos de pago del cliente                                                                                                                                                                                                                                                                                        |
| POST   | `/portal/me/payment-methods/setup-intent` | NO   | 5/min/IP  | Bearer JWT portal; crea SetupIntent Stripe (self-service IBAN/tarjeta)                                                                                                                                                                                                                                                                      |
| POST   | `/portal/me/payment-methods`              | NO   | 5/min/IP  | Bearer JWT portal; registra el PM confirmado (pasa a predeterminado; tipo derivado del gateway)                                                                                                                                                                                                                                             |
| POST   | `/portal/me/invoices/:id/charge`          | NO   | 5/min/IP  | Bearer JWT portal; cobra el pendiente con el PM predeterminado. 404 si la invoice no es del customer del token; 400 `no_payment_method` si no hay PM                                                                                                                                                                                        |
| GET    | `/portal/me/access`                       | NO   | 60/min/IP | Bearer JWT portal; credenciales pin/qr activas del inquilino con el valor descifrado (para mostrar/presentar)                                                                                                                                                                                                                               |
| POST   | `/portal/me/access/:id/regenerate`        | NO   | 5/min/IP  | Bearer JWT portal; regenera el secreto de SU credencial (404 si no es suya). Devuelve el nuevo valor                                                                                                                                                                                                                                        |
| POST   | `/portal/me/access/extra`                 | NO   | 5/min/IP  | Bearer JWT portal; crea un acceso adicional (PIN, body `{label}`) hasta `tenants.extra_access_limit`. 409 `extra_access_limit_reached` al exceder                                                                                                                                                                                           |
| GET    | `/portal/me/access/night-pass`            | NO   | 60/min/IP | Bearer JWT portal; disponibilidad + precio del pase nocturno + locales del inquilino (`{enabled, price, facilities}`)                                                                                                                                                                                                                       |
| POST   | `/portal/me/access/night-pass`            | NO   | 5/min/IP  | Bearer JWT portal; compra un pase nocturno (PIN de un solo uso que salta el toque de queda, caduca a la mañana siguiente) + factura. Body opcional `{facilityId}`: el PIN solo abre ese local y la factura se imputa a su caja; obligatorio con varios locales (400 `facility_required`, `facility_not_allowed`). 409 `night_pass_disabled` |
| GET    | `/portal/me/waitlist`                     | NO   | 60/min/IP | Bearer JWT portal; tipos **agotados** de los locales donde tiene contrato vivo + sus altas vigentes en la lista de espera                                                                                                                                                                                                                   |
| POST   | `/portal/me/waitlist`                     | NO   | 5/min/IP  | Bearer JWT portal; se apunta a la cola de `{facilityId, unitTypeId}` (idempotente; 404 si no es cliente de ese local; 400 `email_required` sin email)                                                                                                                                                                                       |
| DELETE | `/portal/me/waitlist/:id`                 | NO   | 5/min/IP  | Bearer JWT portal; sale de la cola (solo sus altas; 404 si no es suya)                                                                                                                                                                                                                                                                      |

### Codigos `code` (Fase 4)

| `code`                        | Cuando                                                      |
| ----------------------------- | ----------------------------------------------------------- |
| `invoice_not_found`           | Invoice ID invalido.                                        |
| `invoice_series_not_found`    | Series ID invalido.                                         |
| `invoice_series_code_taken`   | Duplicado en `(tenantId, code)`.                            |
| `invoice_series_inactive`     | Intento de emitir contra una serie desactivada.             |
| `no_default_series`           | Crear invoice sin seriesId y sin default configurada.       |
| `invalid_invoice_transition`  | Transicion no permitida en state machine.                   |
| `invoice_not_editable`        | Editar lineas fuera de draft.                               |
| `invoice_not_payable`         | Mark-paid/charge sobre estado no `issued`/`overdue`.        |
| `invoice_not_refundable`      | Refund sobre estado no `paid`/`partially_refunded`.         |
| `overpayment` / `over_refund` | El importe excede pendiente/cobrado.                        |
| `invalid_amount`              | Charge con amount fuera de rango.                           |
| `no_payment_method`           | Charge sin payment_method especificado y sin default.       |
| `payment_method_not_found`    | Payment method ID invalido.                                 |
| `portal_token_invalid`        | Magic link o JWT portal con formato/secret invalido.        |
| `portal_token_expired`        | Magic link expirado (TTL 30 min) o single-use ya consumido. |
| `has_active_contract`         | Anonimizar customer con contratos activos.                  |

### Verifactu detail

- Algoritmo del hash: `sha256("${tenantTaxId}|${invoiceNumber}|${issueDate}|${total}|${previousHash ?? ''}")`.
- QR AEAT: URL `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=&numserie=&fecha=&importe=` renderizada con `qrcode` lib a data:image/png base64. Embebida en el PDF.
- Envio: en `AEAT_MODE=stub` (default Fase 4) marca `aeat_status='accepted'` sin tocar AEAT. En sandbox/production (Fase 8) lanza job a la cola `verifactu` con XML firmado.

### BullMQ + Cron jobs

| Cron            | Cola      | Job                          | Descripcion                                                             |
| --------------- | --------- | ---------------------------- | ----------------------------------------------------------------------- |
| `0 2 * * *`     | billing   | `generate-recurring`         | Por cada tenant activo: drafts por contrato sin invoice para el periodo |
| `0 6 * * *`     | dunning   | `process-invoice` (per inv.) | Marca overdue + programa acciones (+1/+7/+14/+30)                       |
| `0 6 * * *`     | dunning   | `execute-action` (per act.)  | Despacha acciones cuyo `scheduled_for <= now()`                         |
| (futuro Fase 8) | verifactu | `send-to-aeat`               | Envio real a AEAT sandbox/production                                    |

## Comunicaciones, automations, leads y widget (Fase 5)

Modulos `apps/api/src/modules/{communications,automations,leads,widget}/`.

### Invariantes clave

- **Outbox pattern**: toda comunicacion se persiste en `communications`
  ANTES de pasar al provider. El worker BullMQ toma `pending`, marca
  `processing`, llama al provider y marca `sent/failed`. Si el proceso
  cae, las pending sobreviven y se reintentaran.
- **EmailProvider abstracto**: `EMAIL_PROVIDER=smtp|resend`. SMTP usa
  nodemailer (Mailpit en dev). Resend usa la REST API (`RESEND_API_KEY`).
  Cambiar provider = una variable de entorno.
- **WhatsAppProvider abstracto**: en Fase 5 solo `whatsapp_stub` (loggea).
  En Fase 8 se anade `MetaWabaProvider` sin tocar el caller.
- **Templating Handlebars + whitelist por trigger**: cada trigger tiene
  una lista de variables permitidas (`TEMPLATE_VARIABLES_BY_TRIGGER`).
  Cuando una plantilla se renderiza con `trigger`, las variables fuera
  de la whitelist se ignoran. Defensa contra filtrado accidental.
- **Plantillas system son inmutables**: `kind='system'` rechaza PATCH/DELETE.
  Built-ins se crean con `kind='transactional'` (editables) para que el
  tenant pueda personalizarlas.
- **Automations event-driven**: services emiten eventos via `EventEmitter2`.
  `AutomationsService` escucha, matchea reglas activas por trigger y
  encola `automation_run` en la cola `automations`. El worker resuelve
  la communication via `CommunicationsService.enqueue`.
- **Leads state machine**: `new → contacted → qualified → won|lost` (con
  vuelta atras en transiciones tempranas). Conversion atomic crea
  customer y, opcionalmente, reservation.
- **Widget publico**: endpoints sin auth bajo `/public/widget/:slug/*`,
  con throttle estricto (5/min/IP en POST), honeypot anti-bot
  (`hp` debe estar vacio), CSP `frame-ancestors *` + `X-Frame-Options:
ALLOWALL` en la ruta `/widget/[slug]` del Next.

### Endpoints — Communications

| Metodo | Ruta                        | Auth | Roles                 | Descripcion                                                                                                                                                                                |
| ------ | --------------------------- | ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/communications`           | SI   | cualquiera            | Filtros `?status=&channel=&customerId=&leadId=&contractId=&invoiceId=&source=` (ids UUID, si no 400 `invalid_id`); cada fila trae `contractNumber`/`unitCode`/`invoiceNumber` para enlazar |
| GET    | `/communications/:id`       | SI   | cualquiera            | Detalle                                                                                                                                                                                    |
| POST   | `/communications`           | SI   | owner, manager, staff | Envio manual (resuelve template + outbox + queue)                                                                                                                                          |
| POST   | `/communications/:id/retry` | SI   | owner, manager        | Reintenta una en estado `failed`/`bounced`                                                                                                                                                 |

### Endpoints — Message templates

| Metodo | Ruta                         | Auth | Roles          | Descripcion                                                       |
| ------ | ---------------------------- | ---- | -------------- | ----------------------------------------------------------------- |
| GET    | `/message-templates`         | SI   | cualquiera     | Lista plantillas del tenant                                       |
| GET    | `/message-templates/:id`     | SI   | cualquiera     | Detalle                                                           |
| POST   | `/message-templates`         | SI   | owner, manager | Crea (409 `message_template_code_taken`)                          |
| PATCH  | `/message-templates/:id`     | SI   | owner, manager | Edita (409 `message_template_system_readonly` si `kind='system'`) |
| DELETE | `/message-templates/:id`     | SI   | owner, manager | Soft delete (igual restriccion para system)                       |
| POST   | `/message-templates/preview` | SI   | cualquiera     | Renderiza una plantilla en memoria con variables de muestra       |

### Endpoints — Automations

| Metodo | Ruta               | Auth | Roles          | Descripcion                                      |
| ------ | ------------------ | ---- | -------------- | ------------------------------------------------ |
| GET    | `/automations`     | SI   | cualquiera     | Lista reglas                                     |
| POST   | `/automations`     | SI   | owner, manager | Crea regla (trigger + actionType + templateId)   |
| PATCH  | `/automations/:id` | SI   | owner, manager | Edita (toggle isActive, cambiar template, delay) |
| DELETE | `/automations/:id` | SI   | owner, manager | Borra (cascada de `automation_runs` historicos)  |

### Endpoints — Leads

| Metodo | Ruta                    | Auth | Roles                 | Descripcion                                          |
| ------ | ----------------------- | ---- | --------------------- | ---------------------------------------------------- |
| GET    | `/leads`                | SI   | cualquiera            | Filtros `?status=&assignedToUserId=&source=&search=` |
| GET    | `/leads/:id`            | SI   | cualquiera            | Detalle                                              |
| POST   | `/leads`                | SI   | owner, manager, staff | Crea (source default `manual`)                       |
| PATCH  | `/leads/:id`            | SI   | owner, manager, staff | Edita                                                |
| POST   | `/leads/:id/transition` | SI   | owner, manager, staff | Cambia estado segun state machine                    |
| POST   | `/leads/:id/reply`      | SI   | communications:send   | Email al contacto `{subject, body}` (new→contacted)  |
| POST   | `/leads/:id/marketing`  | SI   | owner, manager, staff | Consentimiento comercial `{consent}` (false = baja)  |
| POST   | `/leads/:id/convert`    | SI   | owner, manager, staff | Crea customer + (opcional) reservation, marca won    |
| DELETE | `/leads/:id`            | SI   | owner, manager        | Soft delete                                          |

**Seguimiento comercial de los contactos (2026-10-25)** — `LeadCrmController`, registrado antes que `LeadsController`:

- `GET/PUT /leads/settings` (`leads:read` / `settings:manage`): `{responseHours, autoAssign}` — horas sin atender antes de avisar (4) y reparto de los contactos nuevos (`off` | `round_robin` | `facility`: por turnos entre quien ve el local del contacto). El reparto avisa al asignado (`lead.assigned`); el cron `leads.unattended` (minuto 20 de cada hora, en el API, reserva por contacto) avisa una vez de los nuevos sin atender (`lead.unattended`, también por push).
- `GET /leads/response-stats?days=` (`leads:read`): mediana de horas hasta la primera respuesta, % dentro del plazo y sin atender ahora, en total y por persona asignada.
- `GET /leads/:id/followups`, `POST` `{title, note?, dueDate}`, `GET /leads/followups/pending`, `PATCH /leads/followups/:followupId {status}`, `DELETE` (`leads:read` / `leads:write`). Los vencidos salen en «Hoy» (`leadFollowupsDue`) junto a los contactos sin atender (`unattendedLeads`).
- `GET /leads/:id/activities`, `POST` `{type, content, occurredAt?}`, `DELETE /leads/:id/activities/:activityId`: una llamada, visita, reunión, WhatsApp o email cuenta como primera respuesta (`contactedAt`, de «Nuevo» a «Contactado»).
- `GET /leads/duplicates`: contactos abiertos con el mismo email o teléfono (últimas 9 cifras) y el inquilino que lo comparte; `POST /leads/:id/merge {intoLeadId}` (`leads:manage`, completa datos, une mensajes y mueve seguimientos, actividad, correos y conversaciones; el origen queda borrado) y `POST /leads/:id/link-customer {customerId}` (enlaza y pasa a ganado).
- `LeadDto.score` (0-100) y `scoreReasons`: `leadScore` de shared (datos que dejó, plazo, origen, fase y antigüedad).

### Endpoints — Widget publico

| Metodo | Ruta                                  | Auth | Throttle  | Descripcion                                                                                       |
| ------ | ------------------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/public/widget/:slug/facilities`     | NO   | 30/min/IP | Lista locales activos del tenant con unit types                                                   |
| POST   | `/public/widget/:slug/leads`          | NO   | 5/min/IP  | Crea lead `source=widget` con honeypot anti-bot                                                   |
| GET    | `/public/landing/:slug`               | NO   | 60/min/IP | Landing SEO: empresa + locales (dirección/contacto) + disponibilidad/precio. Alimenta `/s/[slug]` |
| GET    | `/public/landing/:slug/:facilitySlug` | NO   | 60/min/IP | Landing SEO de un local concreto (por `publicSlug`). Alimenta `/s/[slug]/[facility]`              |
| GET    | `/public/landing/sitemap`             | NO   | 30/min/IP | URLs indexables (tenants activos + slugs de locales). Alimenta `app/sitemap.ts`                   |

**Web pública (2026-10-17)**:

- Los tamaños de cada local (`PublicLandingUnitTypeDto`, disponibilidad de la reserva) solo incluyen los que tiene ese local; `priceMonthly` es el del **trastero más barato disponible** de ese tamaño (agotado: el más barato que tenga) y la reserva asigna ese trastero; `taxRate` es el IVA del alquiler (21, o 0 en viviendas).
- `PublicSitemapEntryDto.customDomain`: con dominio propio verificado, sus páginas van en `https://<dominio>/sitemap.xml` (y su `robots.txt`), no en el de la plataforma.
- `POST /public/move-in/book/:slug`: 400 `start_date_too_far` si la entrada es a más de un año. Con envío real a la AEAT (`AEAT_MODE` ≠ `stub`), 400 `invalid_tax_id` si el DNI/NIE no es válido.
- Notificación `invoice.first_invoice_failed`: la primera factura de un contrato no se pudo emitir (motivo en el cuerpo; enlaza a la factura si llegó a crearse).
- Las llamadas del servidor del web con `x-internal-token` = `INTERNAL_API_TOKEN` no cuentan en el límite de peticiones.

### Codigos `code` (Fase 5)

| `code`                             | Cuando                                                |
| ---------------------------------- | ----------------------------------------------------- |
| `message_template_not_found`       | Template ID/code invalido.                            |
| `message_template_code_taken`      | Duplicado en `(tenantId, code)`.                      |
| `message_template_system_readonly` | Intentar editar/borrar una plantilla `kind='system'`. |
| `communication_not_found`          | Communication ID invalido.                            |
| `communication_not_retriable`      | Retry sobre algo distinto de `failed`/`bounced`.      |
| `communication_body_required`      | Send sin template ni `bodyText`.                      |
| `automation_rule_not_found`        | Rule ID invalido.                                     |
| `lead_not_found`                   | Lead ID invalido o soft-deleted.                      |
| `invalid_lead_transition`          | Transicion fuera de la state machine.                 |
| `lead_already_won`                 | Reintento de convert sobre lead ya cerrado.           |
| `invalid_payload`                  | Widget: honeypot detectado.                           |
| `tenant_not_found`                 | Widget: slug invalido o tenant borrado.               |

### BullMQ + colas Fase 5

| Cola             | Job        | Descripcion                                                              |
| ---------------- | ---------- | ------------------------------------------------------------------------ |
| `communications` | `dispatch` | Envia una communication via su provider (email/whatsapp/sms)             |
| `automations`    | `run`      | Aplica una regla a un evento concreto, crea la communication y la encola |

**Revisión de Inventario (2026-10-25).** Los trasteros de un local borrado desaparecen del panel (`/units`, ficha 404, ocupación, límites del plan, analítica y contratos nuevos); borrar un local libera su `publicSlug` y quitar imágenes las borra del almacenamiento. `GET /units` ordena por código. Un código de trastero no se repite en el local sin distinguir mayúsculas (409 `unit_code_taken`). Un trastero sin contratos ni reservas se puede borrar aunque haya cambiado de estado. Con un contrato en vigor no se cambia su tipo de trastero a vivienda ni al revés (400 `cannot_change_kind_while_rented`). Horario: apertura antes del cierre (400); toque de queda con inicio y fin distintos (400 `invalid_curfew`). Las rutas de plantas (`/facilities/:id/floors`, `/floors/:id…`) y el stock y las ventas de productos comprueban el alcance por local (403 `facility_not_in_scope`); el stock exige un local existente (404 `facility_not_found`). `POST /inventory/issues/:unitId/fix` (`units:write`) pone a un trastero descuadrado el estado que le corresponde, también «ocupado» (409 `no_inventory_issue` si ya no lo está). La reserva online, su resumen y la contratación del portal no ofrecen locales ni tipos desactivados.

**Funcionalidades de Inventario (2026-10-25, PR B).**

| Método       | Ruta                                             | Descripción                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- | -------------------------------------------------------------------------------------------------- |
| GET          | `/facilities/summary`                            | Por local: cuotas de los contratos vivos, cuota media, m² totales y alquilados, facturado del mes, días del trastero que más lleva libre y trasteros fuera de servicio                                                     |
| GET/POST     | `/facilities/:id/documents`                      | Documentos internos del local (`facilities:read` / `facilities:manage`); el alta recibe la clave subida con `POST …/documents/upload-url` (PDF o imagen, ≤20 MB; 400 `invalid_document_key` fuera de la carpeta del local) |
| PATCH/DELETE | `/facilities/:id/documents/:documentId`          | Cambiar tipo, nombre o caducidad (`expiresOn: null` la quita) o borrar (también del almacenamiento)                                                                                                                        |
| GET          | `/facilities/:id/documents/:documentId/download` | Enlace firmado de 5 min                                                                                                                                                                                                    |
| GET          | `/floors/:id/occupants`                          | Inquilino, contrato y deuda vencida de cada trastero ocupado de la planta (`customers:read`)                                                                                                                               |
| GET          | `/units/:id/insights`                            | Historial de precios e inquilinos, días libre, días alquilado del último año y facturado en 12 meses (y por m²)                                                                                                            |
| POST         | `/units/bulk`                                    | `{action: status                                                                                                                                                                                                           | type | floor | price, unitIds}`(máx. 500); cada trastero con sus reglas, devuelve`updated`y`failed` con el motivo |
| POST         | `/units/bulk-create`                             | `{prefix, start, count, padding, …medidas}` crea «A-01…» (máx. 200); los códigos que ya existen van en `skipped`                                                                                                           |
| GET          | `/products/:id/stock/movements`                  | Últimos 200 movimientos de stock                                                                                                                                                                                           |
| GET          | `/owners/overview`                               | Por propietario: locales con trasteros y ocupados, cuotas al mes y cobrado el mes pasado; y locales sin propietario                                                                                                        |

`POST /units/:id/change-status` acepta `until` (vuelta prevista, en mantenimiento) y `createTask` (crea una tarea de mantenimiento del trastero). `POST/PATCH /products` aceptan `minStock`; `ProductDto` gana `minStock` y `lowStock`. `GET /dashboard/today` añade `lowStock`, `unitsOutOfService` (mantenimiento o bloqueado más de 7 días o pasada la fecha prevista) y `facilityDocumentsExpiring` (30 días).

**Revisión de Trasteros (2026-11-06).**

- `POST /units/:id/change-status`: un trastero con contrato en vigor no cambia a mano (409 `unit_has_live_contract`; una reserva anticipada sin empezar no cuenta). «Reservado» ya no se pone a mano (400 `invalid_status_transition`). `until` no admite una fecha pasada (400 `invalid_until`) y, en mantenimiento, cambiar la fecha deja una línea en el historial. Si al pasar a `available` el trastero sigue guardado para alguien, vuelve a `reserved` (la respuesta trae el estado real); desde `reserved` sigue siendo 409 `unit_held_by_other`. Al salir de mantenimiento se cierra su tarea. `createTask` necesita además `tasks:write`.
- `PATCH /units/:id`: mandar el tipo o la planta sin cambiarlos no falla en un apilado; cambiarlos sí (400 `cannot_change_type_while_stacked`, `cannot_change_floor_while_stacked`). Cambiar de planta borra la posición en el plano.
- `DELETE /units/:id`: 409 `unit_stacked` (hay que desapilar), 409 `unit_has_history` (también si un contrato se trasladó a otro) y 409 `unit_has_pending` (traslado programado, lista de espera, oferta, solicitud, petición de cambio o cerradura; el mensaje dice qué falta).
- `GET /units`: `search` mira también inquilino y número de contrato con `customers:read`. `facilityId`, `floorId`, `unitTypeId` y `cursor` no válidos dan 400 `invalid_id`; `limit` no numérico se ignora.
- `POST /units/bulk`: `failed[]` lleva `unitCode`, y un fallo interno no enseña su texto. Precio: `set` exige más de 0, `percent` entre -90 y 1.000 sin ser 0, y un resultado fuera de rango falla por trastero (`invalid_price`).
- `POST /units/bulk-create`: `{created, skipped, overLimit, failed}`. `skipped` son los que ya existían, `overLimit` los que no caben en el plan y `failed` dónde se paró.
- `GET /units/:id/insights`: el historial sale de `unit_tenancies`, así que un traslado queda en los dos trasteros (`movedAway`). `invoiced` y `revenue12m` van sin IVA y sin contar dos veces una sustitutiva. `daysTrackedLastYear` son los días que se miran (365, o menos en un trastero reciente).
- `GET /inventory/issues`: ya no marca lo guardado para la cola o un traslado programado, y avisa de un trastero reservado o fuera de servicio con el inquilino dentro (→ `occupied`).
- Medidas hasta 500 m (alto 50 m) y precio hasta 999.999 €: fuera de eso, 400.

**Mejoras de Trasteros (2026-11-06).**

- `GET /units/overview?facilityId=` (`units:read`): la lista con `tenant` (nombre, contrato, `monthly` y `overdue`), `daysVacant`, `offer` y `outOfService` (`days`, `lostIncome`). Trae `tenantsVisible` (`customers:read`) y `moneyVisible` (`customers:read`, `invoices:read` y `payments:read`): sin permiso, `tenant` es null u `overdue` es null.
- `GET/POST /units/views` y `DELETE /units/views/:id`: vistas del equipo. Guardar con un nombre que ya existe la sustituye (leer `units:read`, guardar y borrar `units:write`).
- `POST /units/:id/images/upload-url` y `PUT /units/:id/images {images}` (`units:write`): fotos del trastero, hasta 12, en el bucket público. Una clave de otra carpeta da 400 `invalid_image_key`.
- `POST/PATCH /units`: `features` (`UnitFeatureEnum`). `UnitDto` gana `features`, `images`, `outOfServiceReason` y `outOfServiceSince`.
- `POST /units/:id/change-status`: guarda el motivo y desde cuándo al pasar a mantenimiento o bloqueado; pasar de uno a otro conserva la fecha, y se borran al volver.
- `POST /units/bulk`: el precio admite `round` (`none`, `euro`, `five`).
- `GET /units/:id/insights`: `currentFee` (lo que paga el inquilino actual) y `stackPartner`.

**Revisión de Locales (2026-11-06).**

- Errores de validación: `message` dice qué campo falla y por qué (`Email no válido`, `Nombre: Mínimo 2 caracteres`) en vez de `Validation failed`, en toda la API. `details` no cambia.
- `GET /facilities/:id/delete-preview` (`facilities:manage`): `blockers` (`kind`, `count`, `label`, `href`), `turnsOff` (`maintenancePlans`, `recurringExpenses`, `accessDevices`, `cameraDevices`), `unitsCount` y `usersLeftWithoutFacilities` (quien solo ve ese local).
- `DELETE /facilities/:id`: 409 `facility_has_live_contracts` o `facility_has_pending` (`details.blockers`) con borradores, reservas, traslados programados hacia él o lista de espera. Al borrar se apagan sus planes, gastos recurrentes, puertas y cámaras.
- `POST /facilities`: quien solo ve unos locales queda asignado al que crea.
- `POST/PATCH /facilities`: 409 `facility_name_taken` (sin distinguir mayúsculas); 400 `coordinates_incomplete` (`latitude` y `longitude` admiten `null`, las dos o ninguna); 400 `curfew_hours_required` e `invalid_curfew`, también al crear; `timezone` validada; `videoUrl` solo `http(s)`.
- `PATCH /facilities/:id`: `publicSlug` da 409 `slug_taken` con `details.suggestion` (ocupada, reservada o `trasteros-en-…`) y 400 `slug_required` si va vacía.
- `PUT /facilities/:id/images`: solo comprueba las nuevas, con tope real de 2 MB; 400 `file_not_uploaded` si no existe.
- `GET /facilities/summary`: gana `totalUnits` y `occupiedUnits`; todo con las definiciones del Resumen. `mrr`, `avgPrice` e `invoicedMonth` llegan a null sin `invoices:read` y `payments:read`. Igual `mrr` y `overdue` en `byFacility` de `GET /dashboard/overview`.
- `POST /contracts/:id/sign`: 409 `facility_deleted`. `POST /contracts/:id/change-unit`: 404 si el destino es de un local borrado.
- `PATCH /unit-types/:id`: 409 `cannot_change_kind_while_rented` al pasar de trastero a vivienda (o al revés) con contratos en vigor. Precio y fianza hasta 999.999 €. `unitsCount` no cuenta locales borrados.
- `POST /floors` y `PATCH /floors/:id`: 409 `floor_name_taken`. Las rutas de una planta dan 404 si su local está borrado. `PATCH /floors/:id/plan`: tope de 5 MB, 400 `file_not_uploaded` y borra el plano anterior. `DELETE /floors/:id/plan` lo quita.
- `POST /access/devices/:id/open`: 409 `device_inactive`. `POST /access/devices` y `POST /cameras/devices`: 404 si el local no existe o está borrado.
- `POST /leads/:id/quote/preview`: 409 `facility_inactive` si el local está desactivado.
- `GET /search`: encuentra locales (`type: 'facility'`) por nombre o ciudad y no enseña trasteros de locales borrados.

**Mejoras de Locales (2026-11-06).** Migración `20261230100000_facilities_features`.

- `GET /facilities/:id/overview` (`facilities:read`): `byType` (total, ocupados, reservados, libres, fuera de servicio y precio medio), `moveIns`/`moveOuts` de 30 días, `waitlist`, `tenantsReachable`, `openIncidents`, `expiringDocuments`, `offlineDevices` y `publicUrl`. `mrr` y `overdue` llegan a null sin `invoices:read` y `payments:read`.
- `GET /facilities/summary`: gana `overdue`, `moveIns` y `moveOuts` (del mes).
- `GET /facilities/deleted` y `POST /facilities/:id/restore` (`facilities:manage`): la papelera, durante 30 días (`FACILITY_RESTORE_DAYS`). Restaurar vuelve a encender solo lo que apagó el borrado y devuelve `{facility, restored}`. 409 `facility_restore_expired` y `facility_name_taken`; respeta el límite del plan. Si otro local tomó su dirección, recibe una libre.
- `POST /facilities/:id/duplicate {name}` (`facilities:manage`): copia horario, días especiales, toque de queda, características, contacto, propietario y plantas. No copia dirección, fotos, planos ni trasteros.
- `GET /facilities/:id/team` (`users:read`): `access` = `assigned` o `all`. `GET /facilities/:id/history?cursor=` (`facilities:manage`): lo auditado del local y de sus plantas, también de las ya borradas.
- `POST /customers/by-facility/:facilityId/message {subject, bodyText}` (`communications:send`) → `{sent}`: aviso de servicio a los inquilinos en vigor del local, también a quien se dio de baja de las ofertas.
- `POST/PATCH /facilities`: `openingHours` admite `open2`/`close2` (segundo turno) y `00:00–00:00` (24 horas); nuevos `openingExceptions` (`[{date, label?, hours|null}]`, hasta 60), `directions` y `mapsUrl`. Un enlace largo de Google Maps rellena las coordenadas si el local no tiene.
- `PUT /facilities/:id/images`: `alts` opcional (`{key: texto}`); sin él se conservan los que había. `FacilityDto.images[].alt`.
- `PATCH /facilities/:id` con otro `publicSlug`: la dirección antigua queda en `facility_slug_redirects`. `GET /public/landing/:slug/:facilitySlug` responde 404 `facility_moved` con `details.slug` y la web redirige con un 308. Deja de redirigir si otro local o una landing con dirección corta se la queda.
- Web y área de clientes: `PublicLandingFacilityDto` gana `openingExceptions`, `features`, `directions`, `mapsUrl` e `imageAlts`; `PortalFacilityDto`, `openingExceptions` (los próximos 30 días) y `directions`, y `directionsUrl` usa `mapsUrl` si lo hay.

## Operativa, productos, analytics y reports (Fase 6)

**Funcionalidades de la Operativa (2026-10-25, PR B).** Migración `20261114100000_operations_features`.

- `GET /contracts/:id/checklist` (`contracts:read`) → `ContractChecklistDto`: pasos de la entrada (firmado, fotos, primera factura cobrada, fianza, acceso) y, con la baja pedida o cerrado, de la salida (fotos, fianza liquidada, acceso retirado, cerrado).
- `POST /unit-change-requests/:id/move {newUnitId, newPrice?, prorate?}` (`contracts:manage`): traslada el contrato y deja la solicitud gestionada (400 `already_resolved`, `request_without_contract`).
- `POST /tasks/bulk-assign {taskIds, assignedToUserId|null}` (`tasks:write`) → `{updated}`. Asignar una tarea o incidencia avisa a esa persona (notificación `task.assigned` / `incident.assigned`, solo suya, y push).
- `GET/PUT /tasks/auto-rules` (`tasks:read` / `tasks:manage`): llamada de bienvenida N días tras firmar, revisión del trastero N días tras el cierre y llamada para renovar a 30 días del fin sin renovación automática. Una tarea por regla y contrato.
- `GET /incidents/:id/context` (`incidents:read`): trastero, últimos 5 contratos y últimos 15 accesos del trastero o del inquilino.
- Señal de reserva: al confirmar una reserva con `depositAmount > 0` e inquilino se emite su factura («Señal de reserva», IVA del alquiler); `POST /reservations/:id/deposit-invoice` (`invoices:manage`, idempotente; 400 `no_deposit`, `customer_required`, `reservation_not_active`). Al cobrarla, `depositPaid`; al convertir, su base pasa a `contracts.pending_credit_amount` y se resta del alquiler de la primera factura (primera factura del alta o recurrente). `ReservationDto.depositInvoiceId`.
- `GET/POST /customers/:id/authorized-persons`, `PATCH/DELETE …/:personId` (`customers:read` / `customers:write`).
- `GET /access/logs/report?days=&facilityId=` (`access:read`, 1-90): totales, por día y por hora en la hora del tenant, quién entra más y quién acumula denegaciones.
- `GET /access/door?facilityId=` (`access:read`): dispositivos, entradas y salidas de hoy y últimos accesos del local. `POST /access/door/visitor-pin {customerId, facilityId, label?}` (`access:manage`) → PIN de un solo uso hasta el final del día del local.
- Calendario: las tareas enlazan a `/tasks?task=<id>`.

**Revisión de la Operativa (2026-10-25, PR A).** Sin migración.

- Contratos que llegan a su fecha de fin (cron `contracts.auto-end`, 05:30): con renovación automática se prorrogan por el mismo plazo (evento `note_added` `auto_renewed`); sin ella pasan a `ending` y se cierran como una baja.
- `POST /contracts/:id/sign` → 409 `unit_reserved_for_other` si el trastero tiene una reserva viva de otro inquilino; la del mismo inquilino queda `converted`.
- `POST /contracts/:id/change-unit` emite `contract_unit_changed` (el acceso del inquilino pasa a abrir el trastero nuevo) y `unit_available` del antiguo; el ajuste prorrateado usa el día en la zona del local.
- `POST /reservations/:id/confirm` → 409 `unit_not_reservable` si el trastero ya está ocupado, en mantenimiento o bloqueado. `ReservationDto.unitPriceMonthly`.
- `DELETE /customers/:id` → 409 `customer_has_live_contracts` con contratos sin cerrar.
- Tareas, incidencias, planes de mantenimiento y peticiones de trastero comprueban el local del usuario también por id (403 `facility_not_in_scope`); lo que no tiene local es de toda la empresa.
- Incidencias: una `resolved` se puede reabrir (`reported`).
- `PATCH /maintenance-plans/:id` acepta `freq`, `interval`, `weekdays`, `dayOfMonth` y `startDate` (recalcula `nextRunDate`; 400 `weekdays_required`/`day_of_month_required`).
- `GET /calendar` incluye `contract_starting` (entradas) y las reservas confirmadas.
- `GET /access/logs?before=<ISO>` pagina de 200 en 200; `to=YYYY-MM-DD` incluye ese día; fecha no válida → 400 `invalid_date`.

Modulos `apps/api/src/modules/{operations,products,analytics,reports}/`.

### Invariantes clave

- **Tasks vs Incidents**: dos modelos separados con distintos state
  machines (ver ADR-034). Comentarios en tablas dedicadas
  (`task_comments`, `incident_comments`) con soft delete.
- **Tasks**: `open → in_progress → done | cancelled`. Rollback permitido
  `in_progress → open` y `cancelled → open`. `done` es terminal.
- **Incidents**: `reported → investigating → resolved | dismissed`.
  Rollback `dismissed → reported`. `resolved` es terminal. Severity
  `low|medium|high|critical`. Cuando `severity ≥ high` emite
  `domain.incident_created` para que las automations notifiquen.
- **Products**: SKU unico por tenant. Soft delete preserva product_sales
  historicos. Precio + taxRate snapshot en cada venta.
- **Stock por facility**: `product_stock(productId, facilityId, quantity)`.
  Decrement atomic via `updateMany WHERE quantity >= n` (ver ADR-035).
  No se permite stock negativo: la venta falla con `insufficient_stock`.
- **ProductSale**: cada venta crea (opcionalmente) un invoice Verifactu
  reusando `InvoicesService.create + issue` cuando hay customer. Sin
  customer la venta queda `pending` sin invoice (caso "venta libre").
- **Analytics on-demand**: los 4 KPIs se calculan en el momento, sin
  tabla de snapshots (Fase 8 anadira cache diario si hace falta).
- **Reports async**: todo informe pasa por la cola BullMQ `reports`
  incluso los ligeros. `report_runs` tiene status + downloadUrl +
  expiresAt (7 dias). Frontend polling 2s mientras pending/running.

### Endpoints — Tasks

| Metodo | Ruta                    | Auth | Roles                 | Descripcion                                                    |
| ------ | ----------------------- | ---- | --------------------- | -------------------------------------------------------------- |
| GET    | `/tasks`                | SI   | cualquiera            | Filtros `?status=&type=&facilityId=&unitId=&assignedToUserId=` |
| GET    | `/tasks/:id`            | SI   | cualquiera            | Detalle                                                        |
| POST   | `/tasks`                | SI   | owner, manager, staff | Crea con assignee, due date, priority                          |
| PATCH  | `/tasks/:id`            | SI   | owner, manager, staff | Edita campos                                                   |
| POST   | `/tasks/:id/transition` | SI   | owner, manager, staff | State machine. 409 `invalid_task_transition`                   |
| DELETE | `/tasks/:id`            | SI   | owner, manager        | Soft delete                                                    |
| GET    | `/tasks/:id/comments`   | SI   | cualquiera            | Lista comentarios cronologica                                  |
| POST   | `/tasks/:id/comments`   | SI   | owner, manager, staff | Anade comentario                                               |

### Endpoints — Incidents

| Metodo | Ruta                        | Auth | Roles                 | Descripcion                                          |
| ------ | --------------------------- | ---- | --------------------- | ---------------------------------------------------- |
| GET    | `/incidents`                | SI   | cualquiera            | Filtros `?status=&severity=&facilityId=&customerId=` |
| GET    | `/incidents/:id`            | SI   | cualquiera            | Detalle                                              |
| POST   | `/incidents`                | SI   | owner, manager, staff | Reporta. Si severity≥high emite event automation     |
| PATCH  | `/incidents/:id`            | SI   | owner, manager, staff | Edita                                                |
| POST   | `/incidents/:id/transition` | SI   | owner, manager, staff | State machine. 409 `invalid_incident_transition`     |
| DELETE | `/incidents/:id`            | SI   | owner, manager        | Soft delete                                          |
| GET    | `/incidents/:id/comments`   | SI   | cualquiera            | Lista                                                |
| POST   | `/incidents/:id/comments`   | SI   | owner, manager, staff | Anade                                                |

### Endpoints — Products + stock + sales

`POST /product-sales` acepta `paymentMethod` (`cash` por defecto, `card`, `bank_transfer` o `pending`). Toda venta lleva factura: F1 con inquilino o simplificada F2 sin él (hasta 400 € con IVA; si no, 400 `customer_required`). Cobrada en el mostrador, el cobro queda en la factura (y en la caja); con `pending` (solo con inquilino) la factura queda pendiente y la venta pasa a pagada al cobrarla. El cobro automático al emitir no toca las facturas de ventas. Cancelar una venta cobrada devuelve el dinero (reembolso con su rectificativa) en vez de intentar anular la factura. Borrar un producto libera su SKU.

| Metodo | Ruta                                | Auth | Roles                 | Descripcion                                         |
| ------ | ----------------------------------- | ---- | --------------------- | --------------------------------------------------- |
| GET    | `/products`                         | SI   | cualquiera            | Filtros `?isActive=&type=`. Incluye `totalStock`    |
| GET    | `/products/:id`                     | SI   | cualquiera            | Detalle con totalStock agregado                     |
| POST   | `/products`                         | SI   | owner, manager        | Crea (409 `product_sku_taken`)                      |
| PATCH  | `/products/:id`                     | SI   | owner, manager        | Edita                                               |
| DELETE | `/products/:id`                     | SI   | owner, manager        | Soft delete (preserva ventas historicas)            |
| GET    | `/products/:productId/stock`        | SI   | cualquiera            | Lista stock por facility                            |
| POST   | `/products/:productId/stock/adjust` | SI   | owner, manager, staff | Delta (200 OK)                                      |
| PUT    | `/products/:productId/stock`        | SI   | owner, manager, staff | Set quantity absoluta                               |
| GET    | `/product-sales`                    | SI   | cualquiera            | Filtros `?customerId=&facilityId=`                  |
| GET    | `/product-sales/:id`                | SI   | cualquiera            | Detalle con items + invoice                         |
| POST   | `/product-sales`                    | SI   | owner, manager, staff | Venta atomica. Crea invoice si customer + serie     |
| POST   | `/product-sales/:id/cancel`         | SI   | owner, manager, staff | Cancela. Restaura stock + cancela invoice si aplica |

### Endpoints — Analytics

| Metodo | Ruta                                 | Auth | Descripcion                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/occupancy`               | SI   | Fisica + economica + MRR actual vs potencial + perFacility                                                                                                                                                                                                                                           |
| GET    | `/analytics/churn?from=&to=`         | SI   | Cohort mensual. Default ultimos 12 meses                                                                                                                                                                                                                                                             |
| GET    | `/analytics/aging?atDate=`           | SI   | Buckets 0-30/30-60/60-90/+90 + totalOutstanding                                                                                                                                                                                                                                                      |
| GET    | `/analytics/leads-funnel?from=&to=`  | SI   | Totales por estado + ratios + bySource                                                                                                                                                                                                                                                               |
| GET    | `/analytics/churn-risk`              | SI   | Riesgo de baja heurístico por contrato (score 0-100 + nivel + factores)                                                                                                                                                                                                                              |
| GET    | `/analytics/pricing-suggestions`     | SI   | Sugerencias de precio por ocupación (yield management, read-only)                                                                                                                                                                                                                                    |
| GET    | `/analytics/forecast?months=`        | SI   | Previsión de MRR + ocupación a N meses (1-24, default 6) por tendencia                                                                                                                                                                                                                               |
| GET    | `/analytics/suggested-actions`       | SI   | «Sugerencias de hoy»: hasta 6 acciones del motor heurístico (cobros/retención/precio/renovaciones). Si el tenant tiene `ai_assistant`, el modelo las reordena y redacta (`aiEnhanced:true`; nunca añade acciones ni cambia enlaces; timeout 8 s y caché 1 h por huella → si falla, lista heurística) |
| GET    | `/analytics/monthly-revenue?months=` | SI   | Ingresos por mes (histórico): facturado (emitido) y cobrado (pagos succeeded) de los últimos N meses (1-24, default 12)                                                                                                                                                                              |
| GET    | `/analytics/leads-utm?from=&to=`     | SI   | Tracking de campañas: leads con UTM agrupados por (origen, campaña) + ganados + tasa de conversión                                                                                                                                                                                                   |

**Revisión de Analítica (2026-10-25).** Todos los endpoints de `/analytics/*` aceptan `?facilityId=` (un local fuera del alcance del usuario devuelve datos vacíos, sin error) y un usuario restringido a ciertos locales solo ve los suyos sin pedirlo. Fechas mal formadas → 400 `invalid_date`. Criterios comunes:

- **MRR** (Ocupación, Resumen, Previsión): cuotas de los contratos `active` y `ending` menos su descuento. **MRR potencial**: `basePriceMonthly` de cada trastero disponible, reservado u ocupado (fuera los de mantenimiento o bloqueados, en `outOfServiceUnits`). `perFacility` lleva `occupied`, `reserved`, `available` y `outOfService`.
- **Bajas** (`/churn`, por defecto 12 meses incluido el actual, máx. 36): contratos firmados; una cancelación de un contrato en marcha es una baja y una reserva online que se canceló sin pagar no cuenta. La estancia media y la previsión usan el mismo criterio.
- **Embudo** (`/leads-funnel`): `totals` = fase actual (cada contacto una vez), `reached` = cuántos llegaron al menos a contactado/cualificado/ganado, `total`, `from`, `to`; las conversiones salen de `reached`.
- **Morosidad, riesgo de baja y «Reclama N facturas»**: solo facturas (`kind: 'invoice'`; fuera las fianzas). El riesgo de baja cuenta cobros fallidos y reclamaciones del último año y considera que tiene cómo pagar quien tiene un mandato SEPA firmado.
- **Precios**: `POST /analytics/unit-pricing-suggestions/apply` da 404 con un trastero de un local que el usuario no ve; `POST /analytics/pricing-suggestions/apply` y `PUT /analytics/pricing-strategy` dan 403 `facility_not_in_scope` a quien solo ve algunos locales (afectan a todos).
- **Comparativa del sector** (`/benchmark`): solo operadores con algún contrato firmado.

**Tendencias (2026-10-25, PR B).** Con `?facilityId=` y el alcance por local como el resto:

| Método | Ruta                                     | Descripción                                                                                                                                                                                                      |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/occupancy-history?months=`   | Ocupación al cerrar cada mes (el actual, hoy) a partir de los contratos: `points` (trasteros, ocupados, %, cuotas) + series `byFacility` y `byUnitType`. 1-36 meses, 12 por defecto                              |
| GET    | `/analytics/revenue-breakdown?from=&to=` | Base sin IVA de las facturas emitidas por concepto (`rent`, `insurance`, `late_fee`, `shop`, `night_pass`, `other`; la fianza no cuenta), por local y (solo alquiler) por tipo. Por defecto los últimos 12 meses |
| GET    | `/analytics/cohorts?months=`             | Contratos por mes de alta: cuántos, % que seguía a los 3/6/12 meses (null si aún no ha pasado), meses de media y facturado por contrato                                                                          |
| GET    | `/analytics/competition-alerts`          | Competidores sin revisar en más de 30 días y bajadas de precio de los últimos 30 días en tamaños (±25 % m²) donde tu precio medio es mayor. También salen en «Sugerencias de hoy» (categoría `competition`)      |

El riesgo de baja pesa entero lo de los últimos 90 días (antes, la mitad), suma 10 puntos a quien tiene un código de acceso activo y no entra en 90 días (o nunca) y devuelve `contractStatus` y `lastAccessAt`. Informes nuevos (`/reports/catalog`, ahora por tenant): `occupancy_snapshot` (ocupación por local), `collections_month` (cobros del mes por forma de pago), `move_outs_period` (bajas del periodo) y `owner_statement` (liquidación de un propietario; solo aparece si el tenant tiene propietarios, con ellos como opciones). El informe de morosidad ya no cuenta las fianzas. El informe mensual por correo compara facturado y cobrado con el mes anterior y añade la ocupación al cerrar el mes, las bajas y los inquilinos en riesgo alto.

### Endpoints — Reports

| Metodo | Ruta                          | Auth | Roles          | Descripcion                                                                                                                                                                                                                                     |
| ------ | ----------------------------- | ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/reports/catalog`            | SI   | `reports:read` | Informes que esta persona puede pedir (según sus permisos y locales), con `paramsSchema`; con más de un local a la vista añade el desplegable `facilityId`                                                                                      |
| GET    | `/reports`                    | SI   | `reports:read` | Últimos 50 informes visibles: con `generatorName`, `paramsLabel` y quién lo pidió. Quien solo ve algunos locales, solo los suyos                                                                                                                |
| GET    | `/reports/:id`                | SI   | `reports:read` | Estado del informe (404 si no lo puede ver)                                                                                                                                                                                                     |
| GET    | `/reports/:id/download`       | SI   | `reports:read` | URL firmada (5 min) que descarga el fichero con su nombre                                                                                                                                                                                       |
| POST   | `/reports/run`                | SI   | `reports:run`  | Comprueba permisos, formato y parámetros (400 `invalid_date`, `invalid_date_range`, `date_range_too_long`, `report_param_required`, `report_format_unsupported`; 403 `report_not_allowed`; 404 `facility_not_found`) y lo encola. 10 por minuto |
| DELETE | `/reports/:id`                | SI   | `reports:run`  | Quita el informe de la lista y borra su fichero                                                                                                                                                                                                 |
| POST   | `/reports/preview`            | SI   | `reports:run`  | Primeras 25 filas, columnas, totales y nº de filas del informe, sin guardarlo (20 por minuto)                                                                                                                                                   |
| GET    | `/reports/schedules`          | SI   | `reports:read` | Envíos por correo (quien solo ve algunos locales, los suyos)                                                                                                                                                                                    |
| POST   | `/reports/schedules`          | SI   | `reports:run`  | `{generator, format, params, frequency: weekly\|monthly, weekday?, dayOfMonth?, hour, recipients[1-5]}`. Las fechas no se guardan: cada envío lleva el periodo anterior. 400 `too_many_schedules` (20 activos)                                  |
| PATCH  | `/reports/schedules/:id`      | SI   | `reports:run`  | `{isActive?, recipients?, hour?}`                                                                                                                                                                                                               |
| DELETE | `/reports/schedules/:id`      | SI   | `reports:run`  | Lo quita                                                                                                                                                                                                                                        |
| POST   | `/reports/schedules/:id/send` | SI   | `reports:run`  | Lo envía ya (5 por minuto)                                                                                                                                                                                                                      |
| GET    | `/public/report-files/:token` | NO   | —              | Enlace del correo: 302 a una dirección firmada de 5 min; 404 `link_expired` pasados 7 días                                                                                                                                                      |

Generators registrados en Fase 6: `invoices_period`, `contracts_active`,
`aging_at_date`. Anadir uno = anadir clase implementando `ReportGenerator`
y declararla en `reports.module.ts`.

### Codigos `code` (Fase 6)

| `code`                         | Cuando                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| `task_not_found`               | Task ID invalido.                                              |
| `invalid_task_transition`      | Transicion fuera del state machine.                            |
| `incident_not_found`           | Incident ID invalido.                                          |
| `invalid_incident_transition`  | Transicion fuera del state machine.                            |
| `product_not_found`            | Product ID invalido.                                           |
| `product_sku_taken`            | Duplicado `(tenantId, sku)`.                                   |
| `product_inactive`             | Venta de producto con `isActive=false`.                        |
| `insufficient_stock`           | Stock por facility insuficiente para la venta solicitada.      |
| `product_sale_not_found`       | Sale ID invalido.                                              |
| `product_sale_not_cancellable` | Cancel sobre status distinto de pending/paid.                  |
| `default_series_required`      | Venta con customer pero sin invoiceSeriesId ni default series. |
| `report_generator_not_found`   | Generator code desconocido.                                    |
| `report_format_unsupported`    | Generator no soporta el formato solicitado.                    |
| `report_run_not_found`         | Report run ID invalido.                                        |

### BullMQ + colas Fase 6

| Cola      | Job        | Descripcion                                                         |
| --------- | ---------- | ------------------------------------------------------------------- |
| `reports` | `generate` | Render PDF/Excel del generator y sube a MinIO; status → done/failed |

## Control de accesos fisicos (Fase 7)

Modulo `apps/api/src/modules/access/`.

> 🔌 **Montaje físico con ESP32** (guía + firmware de ejemplo): [`HARDWARE_ESP32.md`](HARDWARE_ESP32.md). Explica el contrato de `/v1/access/verify` desde el dispositivo y el alta del device.
> 🚧 **Escenario "solo cancela perimetral"** (cada trastero con candado del cliente): [`HARDWARE_CANCELA.md`](HARDWARE_CANCELA.md).

### Invariantes clave

- **Credenciales** con state machine `pending → active → suspended ⇄ active → revoked`. `revoked` es terminal. Soft delete preservando audit.
- **Tipos**: `pin` (4-6 digitos), `qr` (string opaco 12-32 chars), `rfid` (UID hexadecimal).
- **Secret revealed-once**: el `secretHash` argon2id se persiste; el plaintext se devuelve **una sola vez** en el response de create/rotate. Si el cliente lo pierde, hay que rotar.
- **Suspensiones por dunning**: `revokedReason` empieza por `dunning:` cuando viene del cron de morosidad. Listener `domain.invoice_paid` reactiva automaticamente.
- **Devices**: `apiKeyHash` argon2id; verify usa header `X-Device-Key`. Devices se vinculan a `facilityId` y opcionalmente a uno o mas `unitId`.
- **AccessLog**: cada intento queda registrado con `success`, `attemptedValue` sanitizado (PIN last4, QR first8, RFID UID completo), `deviceId`, `credentialId` (si match).
- **LockProvider abstracto**: `LockProvider` interface + `StubLockProvider` (dev/test, no efecto) + `MqttLockProvider` (publica comandos a broker MQTT). Seleccionable via env `LOCK_PROVIDER=stub|mqtt`.

### Endpoints — Access credentials

| Metodo | Ruta                                 | Auth | Roles          | Descripcion                                                                                                                                                                                             |
| ------ | ------------------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/access/credentials`                | SI   | cualquiera     | Filtros `?status=&type=&customerId=&unitId=`                                                                                                                                                            |
| GET    | `/access/credentials/page`           | SI   | cualquiera     | Por páginas: `?search=&facilityId=&status=&method=&customerId=&cursor=`                                                                                                                                 |
| GET    | `/access/credentials/:id`            | SI   | cualquiera     | Detalle sin secret                                                                                                                                                                                      |
| POST   | `/access/credentials`                | SI   | owner, manager | Crea. Devuelve `revealedSecret` (una sola vez). Sin locales elegidos se limita a los trasteros del inquilino; abrir todo pide `allFacilities: true`. 400 `credential_scope_required`, 409 `rfid_in_use` |
| POST   | `/access/credentials/:id/rotate`     | SI   | owner, manager | Genera secret nuevo. Devuelve `revealedSecret`                                                                                                                                                          |
| POST   | `/access/credentials/:id/transition` | SI   | owner, manager | State machine                                                                                                                                                                                           |
| DELETE | `/access/credentials/:id`            | SI   | owner, manager | Revoke (no hard delete)                                                                                                                                                                                 |

### Endpoints — Access devices

| Metodo | Ruta                                     | Auth             | Roles          | Descripcion                                                                                    |
| ------ | ---------------------------------------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/access/devices`                        | SI               | cualquiera     | Lista con facility + unitos vinculados                                                         |
| POST   | `/access/devices`                        | SI               | owner, manager | Crea. Devuelve `apiKey` plaintext (una sola vez)                                               |
| POST   | `/access/devices/:id/regenerate-api-key` | SI               | owner, manager | Rota apiKey. Devuelve plaintext nuevo                                                          |
| PATCH  | `/access/devices/:id`                    | SI               | owner, manager | Edita nombre/unidades vinculadas                                                               |
| DELETE | `/access/devices/:id`                    | SI               | owner, manager | Soft delete                                                                                    |
| POST   | `/access/devices/:id/ping`               | SI               | owner, manager | Comprueba la conexión sin abrir: `{supported, online}`                                         |
| POST   | `/access/heartbeat`                      | Clave del equipo | —              | Latido de un equipo que no se puede consultar desde fuera. `{deviceId}` + `X-Device-Key` → 204 |
| POST   | `/access/devices/test-connection`        | SI               | owner, manager | Prueba un equipo sin guardarlo ni abrir. `{provider, controlUrl, controlSecret?}`              |
| POST   | `/access/devices/:id/resync`             | SI               | owner, manager | Reenvía al terminal las credenciales que le tocan. `{sent}`                                    |
| GET    | `/access/sync-status`                    | SI               | cualquiera     | Por terminal: `expected`, `synced`, `failed` y `errors`                                        |
| GET    | `/access/customers/:id`                  | SI               | cualquiera     | Todo el acceso de un inquilino (`CustomerAccessSummaryDto`)                                    |
| POST   | `/access/customers/:id/suspend`          | SI               | owner, manager | Corta todo. `{reason}` → `{changed}`                                                           |
| POST   | `/access/customers/:id/resume`           | SI               | owner, manager | Reactiva todo, también lo cortado por impago → `{changed}`                                     |
| POST   | `/access/customers/:id/resend`           | SI               | owner, manager | Reenvía su PIN por correo → `{sentTo}`. 400 `customer_without_email`, `no_code_to_resend`      |
| GET    | `/access/debt-cuts?facilityId=`          | SI               | owner, manager | Deudores a los que el corte no llegó a aplicarse (`AccessCutPendingDto`)                       |
| POST   | `/access/debt-cuts/:customerId/cut`      | SI               | owner, manager | Corta su acceso → `{suspended}`. 404 `nothing_to_cut`, 409 `access_cut_disabled`               |
| POST   | `/access/debt-cuts/:customerId/skip`     | SI               | owner, manager | No se le corta: sale de la lista (204)                                                         |
| POST   | `/access/debt-cuts/cut-all?facilityId=`  | SI               | owner, manager | Corta a todos los de la lista → `{customers, suspended}`                                       |
| GET    | `/access/temporary`                      | SI               | cualquiera     | Accesos temporales (sin inquilino)                                                             |
| POST   | `/access/temporary`                      | SI               | owner, manager | Crea uno: titular, locales, `validFrom?`, `expiresAt` obligatorio                              |
| GET    | `/access/logs/:id/camera`                | SI               | cualquiera     | Foto de cámara más cercana (±2 min), o null. Solo con la función `cameras`                     |
| POST   | `/access/devices/:id/open`               | SI               | owner, manager | Apertura remota (server→controlador). Registra `access_logs`. `{dispatched, message?}`         |

> Crear/editar device acepta `controlUrl` + `controlSecret` (HMAC) para el provider `LOCK_PROVIDER=http`; el secreto se guarda cifrado y el DTO solo expone `controlUrl` + `hasControlSecret`.

### Endpoints — Access logs + verify

| Metodo | Ruta                | Auth           | Descripcion                                                                                                                |
| ------ | ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/access/logs`      | SI             | Filtros `?credentialId=&deviceId=&success=&from=&to=`                                                                      |
| POST   | `/v1/access/verify` | `X-Device-Key` | Endpoint del device. Body `{ method, credential, deviceId }`. Devuelve `{ result, allowed, customerName?, reason? }` + log |

### Codigos `code` (Fase 7)

| `code`                          | Cuando                                                 |
| ------------------------------- | ------------------------------------------------------ |
| `credential_not_found`          | ID invalido.                                           |
| `credential_secret_invalid`     | Verify con secret incorrecto.                          |
| `credential_status_invalid`     | Verify contra credencial `suspended/revoked`.          |
| `credential_unit_mismatch`      | Credencial no vinculada al unitId del device.          |
| `invalid_credential_transition` | Fuera del state machine.                               |
| `device_not_found`              | Device ID invalido.                                    |
| `device_api_key_invalid`        | Header `X-Device-Key` no matchea ningun device activo. |

## Super admin, soporte y SaaS billing (Fase 8 + 9A)

Modulos `apps/api/src/modules/{admin,billing-saas,support}/`. Para los endpoints de 2FA + cookie refresh ver tambien Fase 9A mas abajo.

### Invariantes clave

- **Super admin desacoplado del tenant**: tabla `super_admins` global (sin `tenant_id`). JWT con `purpose='superadmin'` firmado con `SUPER_ADMIN_JWT_SECRET` independiente del `JWT_SECRET` tenant. `AdminGuard` separado del `JwtAuthGuard`.
- **Impersonation**: `POST /admin/tenants/:id/impersonate` crea un `impersonation_log` (TTL 1h) y firma un access JWT normal con `purpose='impersonation'` + claim `superAdminId`. El audit log queda asociado al super admin.
  - **Solo lectura** (2026-10-18, `{reason, readOnly}`; la web lo marca por defecto): `impersonation_logs.read_only`, el token lleva `role: readonly` + los permisos de `readonly`, y `ImpersonationGuard` (APP_GUARD tras `JwtAuthGuard`) rechaza cualquier petición que no sea GET/HEAD/OPTIONS (403 `impersonation_read_only`). En cualquier modo, `/me`, `/auth/2fa/*` y `/auth/logout-all` no admiten cambios (403 `not_allowed_while_impersonating`). `GET /auth/me` devuelve `impersonation: {expiresAt, readOnly}` y los permisos del token.
  - **En la web**: el panel admin deja el token en `localStorage` (`storageos:impersonation`) con un código de un solo uso y abre `/dashboard?impersonation=<código>`; `AuthBootstrap` lo recoge solo si coincide, lo pasa a `sessionStorage` (vale para esa pestaña) y nunca renueva con la cookie de refresh (sería la sesión de otra persona en ese navegador). Una cookie de sesión `storageos_impersonation` (sin token) evita que el middleware mande al login. Aviso fijo con el tenant, «solo lectura» y la hora de fin; «Salir» → `/impersonation-ended`.
- **Roles `superadmin` y `support`** (2026-10-18): `@RequireSuperadmin()` (403 `insufficient_super_admin_role`) en todo lo que mueve dinero, cambia la configuración global o borra: además de lo de tenant (anonimizar, suspender, impersonar, plan, pagos, add-ons, funciones), `PATCH /admin/tenants/:id`, `PUT /admin/platform-sepa/settings`, crear/confirmar remesas SEPA y marcar devoluciones, `PUT /admin/platform-dunning/settings` y `POST …/run`, `PUT /admin/platform-billing/settings`, `POST /admin/platform-invoices/issue`, `PUT /admin/platform/banner` y `…/legal/:slug`, `PUT /admin/platform-alerts`, reintentar/limpiar colas, `POST /admin/webhooks-cleanup/run` y crear/activar super admins. `support` sigue con lecturas, tickets, respuestas guardadas, seguimientos, conversaciones, emails a un tenant y reenvío de verificación/contraseña. La web desactiva esos botones y avisa en las secciones de solo lectura.
- **Notificaciones del super admin** (2026-10-18): `GET /admin/platform/notifications/page?cursor=&limit=&unread=true` → `{items, nextCursor}` (400 `invalid_cursor`) y `POST /admin/platform/notifications/:id/read` (204). Página `/admin/notifications` (la campana lleva ahí): agrupadas por día, filtro «Sin leer», marcar una al abrirla o todas.
- **Historial del tenant**: `GET /admin/tenants/:id/timeline?before=<ISO>&limit=&kinds=interaction,admin_action,impersonation,payment,invoice,ticket,email,followup` → `{items: AdminTimelineItemDto[], nextBefore}` (400 `invalid_date`, 404). Junta conversaciones, acciones del super admin (`super_admin_audit_logs` con su texto; sin duplicar las que ya salen por su origen), impersonaciones, pagos y facturas de la suscripción, tickets, correos de la plataforma y de ciclo de vida, y seguimientos. Pestaña «Historial» de la ficha con filtros.
- **Cola de aprobación** (`admin_approval_requests`, tabla global con REVOKE): el rol soporte, en vez de un 403, pide la acción con `POST /admin/approvals {tenantId, reason, request: {action, payload}}` (201). `action` = `suspend` | `change_plan` | `extend_trial` | `manual_payment` | `set_features` | `update_tenant` | `assign_addon` | `remove_addon`, con el mismo `payload` que el endpoint de esa acción (validado al pedir: 400). `GET /admin/approvals?status=&tenantId=` (cualquier admin). Solo el super admin: `POST /admin/approvals/:id/approve {note?}` (la ejecuta con los servicios de siempre, en su nombre; si falla queda `failed` con `error`) y `POST …/:id/reject {note?}`; ya resuelta → 409 `approval_already_decided`. Cada solicitud crea una notificación del super admin, sale en `GET /admin/today` (`pendingApprovals`, suma a urgentes) y en el aviso diario por chat; todo auditado (`admin.approval.requested|approved|rejected`).
- **Avisos por Telegram y Slack**: `GET/PUT /admin/chat-alerts` (`telegramBotToken`, `telegramChatId`, `slackWebhookUrl` —solo `https://hooks.slack.com/services/…`—, `dailyEnabled`, `weeklyEnabled`; `''` quita un canal; el token y el webhook van cifrados y nunca se devuelven) + `POST /admin/chat-alerts/test` y `POST /admin/chat-alerts/daily/run` (super admin). El cron `chat-alerts.daily` (08:15 Madrid) manda lo urgente del «Hoy» si hay algo; el resumen semanal también sale por chat con `weeklyEnabled` (aunque el de email esté apagado). Con `NODE_ENV=test` no sale nada a la red.
- **Revisión de suscripciones (2026-10-18)**: `POST /admin/tenants/:id/extend-trial` (y el lote `extend-trials`) → 400 `tenant_has_paid_plan` si el tenant ya paga; a una prueba vencida en Free la vuelve a abrir en `starter`/`trial`. `POST /admin/tenant-lifecycle/run` devuelve también `trialsEnded` (pruebas vencidas pasadas a Free; el cron diario lo hace aunque los correos estén apagados). `POST /admin/platform-sepa/remittance-items/:id/bounce` retira de la suscripción el periodo que pagaba ese adeudo (`past_due` solo si ya venció) y la siguiente remesa vuelve a domiciliarlo (EndToEndId `…-R<n>`). Webhook de Stripe de la suscripción: `metadata.planId` solo cuenta para una suscripción nueva; los avisos terminados (`canceled`/`incomplete_expired`) de una suscripción que no es la guardada se ignoran, y los de la vigente la pasan al plan Free (o la dejan en prueba si nunca pagó).
- **Acciones masivas en Tenants**: `POST /admin/tenants/bulk-tags {tenantIds, add, remove}` (200 `{updated}`; también el rol soporte; auditado `admin.tenants.bulk_tagged`) y `POST /admin/announcements` admite `tenantIds` (manda sobre `audience`/`tag`). La lista tiene selección múltiple con «Etiquetar», «Ampliar prueba» (`extend-trials`) y «Enviar correo» (los dos últimos, solo super admin).
- **Revisión del apartado Tenants (2026-10-29)**: `extend-trials` solo amplía a los tenants que están en prueba (devuelve cuántos); `extend-trial` sobre un suspendido → 400 `tenant_suspended` (hay que reactivarlo antes). `GET /admin/tenants/:id/change-plan-preview` sin `planSlug` → 400 `plan_required`; `GET /admin/tenants?status=` con un estado desconocido → 400 `invalid_status`; `PATCH /admin/tenants/:id` valida la zona horaria (400). `POST /admin/tenants/:id/anonymize` borra además los accesos (secreto, tarjeta y cara), los mensajes, notas, seguimientos, valoraciones, peticiones y lista de espera de los inquilinos, sus fotos de inspección y adjuntos, da de baja sus mandatos SEPA, y quita los secretos del negocio (certificado de la AEAT, Redsys, GoCardless, Holded, acreedor SEPA, dominio de correo, claves de API, webhooks, passkeys y PIN de la app) y el contacto e IBAN de los propietarios y del negocio.
- **Revisión del apartado Tenants (2026-11-23)**:
  - `POST /admin/tenants` → añade `emailSent` y `emailError` (el enlace para elegir contraseña dura 7 días). `POST /admin/tenants/:id/users/:userId/{password-reset,resend-verification}` → 400 `user_inactive` con el usuario desactivado y 400 `email_not_sent` si el correo no sale.
  - `POST /admin/tenants/:id/saas-payments/sync` y `GET /admin/tenants/:id/sepa-mandate/document` pasan a **superadmin**. `GET /admin/tenants/:id/customers`: el rol soporte recibe el documento enmascarado (`***` + 4 últimos) y la lista se corta en 500 (sin inquilinos de prueba).
  - `GET /admin/tenants/:id/timeline?before=`: el cursor es `fecha|id` (`nextBefore` lo devuelve así; una fecha sola sigue valiendo).
  - `GET /admin/tenants/:id/change-plan-preview` añade `owedPeriods` e `inTrial`. `GET /admin/tenants/:id/account` añade `sepaInProgress`. `GET /admin/tenants-overview` añade por fila `cancelsAt` y `healthKind` (`health`|`activation`); `nextChargeAt` es null sin cuota o con la baja programada. `GET /admin/tenants/:id/summary` añade `wouldPay` y `trialEndsAt`.
  - `GET /admin/tenants/:id/reset-preview` añade `issuedInvoices`; bloqueos nuevos `paid_subscription` y `live_gateway_payments`.
  - `POST /admin/tenants/:id/anonymize` → 409 `stripe_cancel_failed` si Stripe no confirma la cancelación de la suscripción. `PATCH /admin/tenants/:id` → 400 `invalid_tax_id` con un NIF español no válido.
  - `POST /admin/tenants/:id/addons/:assignmentId/billing-mode {mode: 'stripe'}` → 400 `addon_price_differs` si el precio congelado no es el del catálogo; quitar o suspender un extra de Stripe → 502 `stripe_item_delete_failed` si Stripe no borra el item.
  - `POST /admin/tenants/:id/retention-playbook` → 400 `tenant_not_live` (suspendido, cancelado o borrado) y 409 `retention_playbook_running` (seguimiento de retención pendiente o playbook en los últimos 14 días).
  - Aprobaciones: caducan a los 30 días (`rejected` con nota); aprobar una vencida → 409 `approval_expired`.
  - `PATCH/DELETE /admin/followups/:id` quedan en el registro (`admin.tenant.followup_updated|deleted`); la fecha del seguimiento tiene que existir (400) y no se asigna a un comercial.
  - `POST /admin/tenants/:id/impersonate`: `readOnly` es `true` por defecto; la sesión lleva los permisos del propietario. Con cambios, 403 `not_allowed_while_impersonating` también en claves de API, webhooks, traspaso de propiedad, quitar el 2FA de otro usuario, invitaciones y acceso al portal de los inquilinos.
  - Cualquier endpoint con token del equipo → 401 `session_revoked` si se cerraron las sesiones del usuario después de emitirlo.
- **Mejoras del apartado Tenants (2026-11-23)**:
  - **Dar de baja**: `POST /admin/tenants/:id/cancel {churnReason, reason, effective: 'now'|'period_end'}` (superadmin) corta los cobros (Stripe cancelada, cuota a pago manual —fuera de la remesa SEPA y del cobro de Redsys— y extras sin próximo cobro) y pasa a `cancelled` hoy o lo programa para el fin del periodo pagado (`cancelScheduledAt`); 400 `already_cancelled`, 409 `cancel_already_scheduled`, 409 `stripe_cancel_failed`. `POST …/cancel/undo {reason}` (superadmin) deshace una programada (400 `no_cancel_scheduled`); vuelve a SEPA o tarjeta si siguen ahí, con Stripe queda en manual. Un cron diario la aplica ese día.
  - **Vista previa**: `GET /admin/tenants/:id/subscription-preview?action=change_plan|billing_mode|exempt|unexempt|end_trial|extend_trial|forgive|cancel&planSlug=&mode=&days=&effective=` → `{before, after, effects, warnings, pricesIncludeVat}` (estado, plan, cobro, fin del periodo, próximo cargo con IVA y deuda). 400 `invalid_preview`.
  - **Incoherencias**: `GET /admin/tenants/:id/consistency` → `{issues: [{code, title, detail, fixLabel}]}`; `POST …/consistency/:code/fix` (superadmin; 409 `issue_not_found` si ya no está).
  - **Pagos a mano**: `POST /admin/tenants/:id/saas-payments/:paymentId/void {reason}` (superadmin): deshace la ampliación del periodo, devuelve el uso del cupón, rectificativa de su factura y vuelve a `past_due` si ya venció; el pago queda `voided` (400 `payment_not_voidable`). Los pagos llevan `voidable`, `voidedAt` y `voidReason`.
  - **Extras**: `PATCH /admin/tenants/:id/addons/:assignmentId {quantity?, priceMonthly?, notes?, nextChargeAt?}` (superadmin; en Stripe, 400 `addon_price_on_stripe`/`addon_date_on_stripe`) y `POST …/addons/:assignmentId/charge-now {provider}` (el cobro del «Hoy», también antes de su fecha). `TenantAddonDto.nextChargeAt`.
  - **Anonimizar**: `POST /admin/tenants/:id/anonymize` admite `graceDays` (0-90; sin indicar o 0 = ahora) y `churnReason`; con días, da de baja si no lo estaba, programa (`scheduledFor`) y avisa al propietario (409 `anonymize_already_scheduled`). `DELETE …/anonymize-schedule {reason}` la cancela. `GET /admin/tenants/:id` ya responde también a un anonimizado (`anonymizedAt`); el DTO añade `canceledAt`, `churnReason`, `cancelScheduledAt/Reason/Note` y `anonymizeScheduledAt`.
  - **Usuarios**: `POST /admin/tenants/:id/users/:userId/change-email {email, reason}` (superadmin; 400 `email_taken`/`same_email`) y `POST …/make-owner {reason}` (superadmin; 400 `already_owner`/`user_inactive`).
  - **Impersonación**: `POST /admin/tenants/:id/impersonate` admite `userId` (entra como ese usuario, con sus permisos y locales). `GET /admin/impersonation-logs` añade `userId`, `userName` y `live`; `POST /admin/impersonation-logs/:id/revoke` ya no es solo de superadmin: el rol soporte corta las suyas (403 `insufficient_super_admin_role` con las de otro).
  - **Aprobaciones**: las pendientes llevan `currentState` y `changedSinceRequest`.
  - **Lista**: `GET /admin/tenants-overview` incluye los anonimizados y añade `anonymized`, `canceledAt`, `churnReason` y `cancelScheduledAt`. `POST /admin/saved-views` admite `columns` y `sort`. `GET /admin/tenant-duplicates?name=&email=&taxId=&billingEmail=` → posibles duplicados con `matches`.
  - **Correo**: `GET /admin/tenants/:id/email-recipients` (propietarios, facturación y equipo, con `defaultSelected` y `blocked`); `POST /admin/tenants/:id/email` admite `recipients` (400 `invalid_recipient` con una dirección que no es del tenant).
  - **Exportación**: `POST /admin/tenants/:id/data-export` pasa a **202** con la exportación `pending` (se genera en la cola `reports` y avisa al terminar); `GET …/data-exports` (historial) y `GET …/data-exports/:exportId/download` → `{url}` (superadmin; 404 `export_not_ready`/`export_expired`). Hojas nuevas también en la del propietario.
  - **Historial**: `GET /admin/tenants/:id/timeline` admite `q`, `from`, `to` (`YYYY-MM-DD`) y `actorId`; la primera página trae `pinned`. `POST /admin/tenants/:id/interactions/:interactionId/pin {pinned}`.
  - **Inquilinos y locales**: `GET /admin/tenants/:id/customers/page?cursor=&limit=&search=` (con `isTest`, `deletedAt`, `debt`, `overdueDebt`; documento enmascarado al rol soporte) y `GET …/facilities/page?cursor=&limit=&search=`.
- **Mejoras del apartado Tenants (2026-10-29)**: `POST /admin/tenants {tenantName, tenantSlug?, ownerName, ownerEmail, planSlug, trialDays, note?}` (superadmin; alta manual: email verificado y enlace para elegir contraseña; 400 `plan_not_active`). `POST /admin/tenants/:id/reactivate` admite `forgivePeriod` (la suscripción `past_due` vuelve a `active` y su fin pasa un mes; 400 `forgive_not_on_stripe` si paga por Stripe). `GET /admin/tenants/:id/anonymize-preview` (superadmin: recuentos y avisos) y `POST …/anonymize` exige `exported: true`. `POST/DELETE /admin/tenants/:id/risk-snooze {days, reason}` («ignorar» en En riesgo; también soporte) y `GET /admin/tenants/at-risk` añade `lowHealth` y `snoozedCount`. `POST /admin/tenants/:id/custom-domain/check` (DNS ahora) y la cola de dominios añade `featureEnabled`/`dnsReadyAt`. `GET /admin/tenants/trials` añade `facilities`/`units`/`activeContracts`. Overview con `taxId` y `billingEmail`. `GET/POST/DELETE /admin/saved-views` (vistas por super admin; misma página + nombre = sustituye; máx. 50). Seguimientos: `assignedToId` al crear y en `PATCH /admin/followups/:id` (también `dueDate` para posponer; 400 `invalid_assignee`), `GET /admin/followups?mine=1`. Historial con `kinds=milestone` (hitos del tenant). `POST /admin/billing-health/invoices/:invoiceId/refresh-aeat` y `…/resend-aeat` (este, superadmin). `GET /admin/tenants/:id/users/:userId/sessions` y `DELETE …/sessions/:sessionId` (superadmin).
- **Asistente IA con todo el negocio y chat de la web (2026-10-29)**: el asistente del panel (`POST /ai/chat`) gana herramientas genéricas — `search_records` (inquilinos, contratos, trasteros, facturas, contactos), `get_record` (`customer|contract|unit|invoice|facility|reservation|incident|task|lead`; contrato, trastero, factura y local también por número, código o nombre) y `list_records` (facturas, cobros, contratos, trasteros, reservas, lista de espera, accesos, contactos, tareas, incidencias, gastos, comunicaciones, campañas, vencimientos, cupones, promociones, valoraciones, cambios de trastero y planes de pago, con `status`, `from`, `to`, `customerId`, `facilityId`) — y `get_collections_month`, `list_debtors`, `get_calendar`, `get_business_settings`, `get_contracts_trend`; cada tipo exige su permiso y respeta el alcance por local. Hasta 8 vueltas de herramientas. **Chat de la web** (público, `VERSION_NEUTRAL`): `POST /public/landing/:slug/chat {visitorId, message ≤500, locale, pagePath?, hp?}` (10/min por IP) → `{answer, leadCaptured, limited: visitor|tenant|null, contact}`; `POST /public/landing/:slug/chat/history {visitorId}` (30/min). 404 `web_chat_unavailable` sin asistente IA, apagado o negocio suspendido. `PublicLandingDto`/`PublicFacilityLandingDto.webChatEnabled`. Panel: `GET/PATCH /web-chat/settings` (`settings:read`/`settings:manage`), `GET /web-chat/stats?days=`, `GET /web-chat/conversations?days=` y `GET /web-chat/conversations/:id` (`marketing:read`). `AiUsageDto` gana `webUsed`/`webLimit`/`webCustomLimit`; `PUT /admin/ai-settings` admite `webModel`, `webMonthlyLimit`, `webVisitorDailyLimit`, y `PUT /admin/tenants/:id/ai-usage` admite `webMonthlyLimit`.
- **Revisión del chat de la web (2026-10-29)**: `GET /web-chat/conversations?days=` pasa a **`GET /web-chat/conversations/page?days=&cursor=&limit=`** → `PageDto<WebChatConversationDto>` (por última actividad; `fallbackCount` = veces que no respondió la IA). `WebChatMessageDto.fallback`. `WebChatStatsDto`: `conversations` cuenta las que tienen mensajes en el periodo (como la lista), `assistantReplies` solo las de la IA, `fallbackReplies` nuevo y `leads` = contactos distintos. `POST /public/landing/:slug/chat/history` → `{messages, limited: visitor|null, contact}` (con el tope del día alcanzado devuelve el contacto del negocio). `PATCH /web-chat/settings` queda en el registro de actividad (`tenant.web_chat_settings_changed`, sin el texto). Un contacto con datos no válidos ya no se promete: la respuesta pide un email o teléfono válidos.
- **Chat de la web y WhatsApp: mejoras (2026-10-29)**: públicos (`VERSION_NEUTRAL`): `POST /public/landing/:slug/chat/stream` (mismo cuerpo que `chat`; eventos SSE `text {delta}` sin las marcas y `done` con `PublicWebChatResultDto`), `POST …/chat/handoff {visitorId, locale}` (5/min), `POST …/chat/contact {visitorId, name, email|phone}` (5/min, crea el contacto si nadie responde) y `POST …/chat/feedback {visitorId, messageId, rating: 1|-1}`. `PublicWebChatResultDto` gana `messageId` y `mode` (ai|human; con human la respuesta va vacía y el mensaje espera al equipo). `chat/history {visitorId, locale}` devuelve mensajes con `id`, `role` visitor|assistant|staff y `rating`, `mode`, `waitingSince`, `handoffEnabled`, `suggestions` y `leadCaptured`. El asistente prepara reservas (`[[RESERVA {…}]]`, misma reserva online) y apunta a la lista de espera (`[[ESPERA {…}]]`). `PublicBookingSchema.visitorId` enlaza la reserva web con la conversación; `BookingAvailabilityDto` gana `webChatEnabled` y `customDomain`. Panel: `GET /web-chat/pending` → `{waiting, unread}`, `GET /web-chat/conversations/page?mode=human`, `POST /web-chat/conversations/:id/messages {body}` (`communications:send`), `PATCH /web-chat/conversations/:id {mode}` y `POST …/:id/suggest-reply` (gasta una consulta del panel); `WebChatSettingsDto`/`PATCH /web-chat/settings` con `bookingsEnabled`, `handoffEnabled`, `sharedInstructions` (+ `whatsappInstructions`); `WebChatStatsDto` con `bookingsInChat`, `bookedAfterChat`, `signedBookings`, `handoffs`, `ratingsUp/Down` y `unansweredQuestions`. WhatsApp: `POST /whatsapp/conversations/:id/suggest-reply`; `WhatsappConversationDto.intent`/`handoffSummary`; `WhatsappAssistantDto` y `PUT /settings/whatsapp/assistant` con `assistantHoursMode`, `teamHours`, `alertIntents`, `followupEnabled`, `followupTemplateName`, `followupTemplateLanguage`. Notificaciones nuevas (también push): `web_chat.handoff`, `web_chat.message`, `web_chat.booking`, `whatsapp.intent`.
- **Resumen del tenant**: `GET /admin/tenants/:id/summary` → `AdminTenantSummaryDto` (lo que aporta al mes, modo de cobro y fin del periodo pagado, usuarios y último acceso, facturado y cobrado en 30 días, vencidas, contratos y ocupación, tickets abiertos, última conversación y próximo seguimiento). Tarjeta encima de las pestañas de la ficha.
- **`@AdminAudit(action)`** + `AdminAuditInterceptor` (APP_INTERCEPTOR en `AdminModule`): al responder bien deja la acción en `super_admin_audit_logs` con el super admin, el id de la ruta y `changes.fields` (solo los nombres de los campos enviados, nunca sus valores). Se usa en la configuración de la plataforma (SEPA, dunning, facturación SaaS, banner, legales, web, alertas, colas, limpieza de webhooks).
- **Support tickets bidireccionales**: tabla `support_tickets` + `support_ticket_messages`. Mensajes con flag `isInternal` para notas privadas admin no visibles al tenant.
- **Stripe Billing SaaS**: distinto del Stripe gateway tenant (Fase 4). El gateway Fase 4 cobra a customers; el de Fase 8 cobra a tenants. `mode='subscription'` Checkout + Customer Portal. Webhooks `customer.subscription.{created,updated,deleted}` + `invoice.payment_*` mapean a `tenant_subscriptions.status`.

### Endpoints — Super admin auth

Ver tambien la subseccion **Fase 9A** mas abajo para 2FA, refresh cookie y recovery codes.

| Metodo | Ruta                          | Auth       | Descripcion                                                                                               |
| ------ | ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/admin/auth/login`           | Public     | Body `{email, password}`. Si 2FA off → access + cookie refresh. Si 2FA on → `{requires2fa, pendingToken}` |
| POST   | `/admin/auth/refresh`         | cookie     | Cookie `super_admin_refresh`. Rota cookie. Paranoid reuse                                                 |
| POST   | `/admin/auth/logout`          | AdminGuard | Revoca sesion actual + borra cookie                                                                       |
| POST   | `/admin/auth/logout-all`      | AdminGuard | Revoca todas las sesiones                                                                                 |
| POST   | `/admin/auth/change-password` | AdminGuard | Body `{currentPassword, newPassword}`. 403 `wrong_password`. Cierra todas las sesiones                    |
| POST   | `/admin/auth/password/forgot` | Public     | Body `{email}`. Siempre 204. Envía un enlace de 1 h                                                       |
| POST   | `/admin/auth/password/reset`  | Public     | Body `{token, newPassword}`. Un solo uso. 400 `invalid_token`                                             |
| GET    | `/admin/auth/me`              | AdminGuard | Datos del super admin                                                                                     |

### Endpoints — Super admin tenants + metrics + impersonation

| Metodo | Ruta                                        | Auth                    | Descripcion                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/tenants`                            | AdminGuard              | Listado con filtros `?status=&plan=&search=`                                                                                                                                                                                                                                                                                                         |
| GET    | `/admin/tenants/:id`                        | AdminGuard              | Detalle + metricas + usuarios                                                                                                                                                                                                                                                                                                                        |
| POST   | `/admin/tenants/:id/suspend`                | AdminGuard              | Cambia status → suspended                                                                                                                                                                                                                                                                                                                            |
| POST   | `/admin/tenants/:id/reactivate`             | AdminGuard              | Cambia status → active                                                                                                                                                                                                                                                                                                                               |
| POST   | `/admin/tenants/:id/extend-trial`           | AdminGuard              | Body `{daysToAdd}`. Mueve `trialEndsAt`                                                                                                                                                                                                                                                                                                              |
| POST   | `/admin/tenants/:id/impersonate`            | AdminGuard              | Devuelve access JWT con purpose='impersonation'                                                                                                                                                                                                                                                                                                      |
| POST   | `/admin/tenants/:id/anonymize`              | AdminGuard              | RGPD: anonimiza customers + staff + PII del tenant, preserva invoices, marca cancelled+deletedAt. Body `{reason}`                                                                                                                                                                                                                                    |
| GET    | `/admin/tenants/:id/reset-preview`          | AdminGuard (superadmin) | Vista previa de «Vaciar los datos de prueba»: `TenantResetPreviewDto` (recuentos de lo que se borra, lo que se conserva, series que vuelven a 1, `blockers` y `warnings`)                                                                                                                                                                            |
| POST   | `/admin/tenants/:id/reset-operational-data` | AdminGuard (superadmin) | Borra inquilinos, contratos, reservas, facturas, cobros, ventas, gastos y lo que cuelga de ellos; conserva locales, trasteros, productos, contactos y configuración; series a 1. Body `{confirmSlug, reason, exported: true}`. 400 `confirm_slug_mismatch`, 409 `tenant_reset_blocked` (facturas reales en la AEAT, negocio propio de la plataforma) |
| GET    | `/admin/metrics`                            | AdminGuard              | KPIs globales (MRR sin IVA, tenants por estado, churn de clientes que pagaban)                                                                                                                                                                                                                                                                       |

### Endpoints — Support tickets

| Metodo | Ruta                                    | Auth        | Descripcion                                                                                                                                      |
| ------ | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/support/tickets`                      | SI (tenant) | Lista del tenant                                                                                                                                 |
| POST   | `/support/tickets`                      | SI (tenant) | Abre ticket                                                                                                                                      |
| GET    | `/support/tickets/:id`                  | SI (tenant) | Detalle + mensajes (sin internal)                                                                                                                |
| POST   | `/support/tickets/:id/messages`         | SI (tenant) | Anade respuesta                                                                                                                                  |
| GET    | `/admin/support/tickets`                | AdminGuard  | Lista global paginada por cursor `{items, nextCursor}`; filtros `?status=&priority=&tenantId=&search=&assignedAdminId=&cursor=&limit=` (máx 100) |
| GET    | `/admin/support/tickets/:id`            | AdminGuard  | Detalle + mensajes (incluye internal)                                                                                                            |
| POST   | `/admin/support/tickets/:id/messages`   | AdminGuard  | Anade mensaje, flag `isInternal` opcional                                                                                                        |
| POST   | `/admin/support/tickets/:id/transition` | AdminGuard  | State machine                                                                                                                                    |
| POST   | `/admin/support/tickets/:id/assign`     | AdminGuard  | Asigna a super admin                                                                                                                             |

> **2027-02-23 (revisión de Métricas y Finanzas)** — Definiciones en `common/saas-metrics.ts`. **Pagan**: suscripción `active` o `past_due` de un tenant `active` (ni en prueba, ni suspendido, ni exento) con cuota > 0; el pago atrasado sigue en el MRR y en los snapshots (`mrr_snapshots.status = past_due`), sin baja ni reactivación. **Prueba sin pagar** (tenant `active`, suscripción `expired`): ni cliente ni baja. **Bajas**: solo de tenants que llegaron a pagar (cobros, snapshots o cuota actual); quien pagó y quedó en solo lectura es baja en el fin de su periodo. **MRR sin IVA** (`tenantMrr`): cuota mensual o anual entre 12 (periodo > 200 días, salvo SEPA/Redsys), con la proporción de descuento del último pago del plan, + extras; lo usan Métricas, snapshots, `/admin/business/tenants/:id`, `GET /admin/today` (`kpis.mrr`, cuota de cada fila y € en riesgo) y `GET /admin/tenants-overview` (`monthly`). Los meses se cortan en hora de España. Cambios de DTO: `AdminMetricsDto.tenants` gana `pastDue` y `readOnly`; `tenantsByPlan[]` solo vivos y gana `trial`/`paying`; `trialsEndedThisMonth.toFree` = terminaron sin pagar y `churned` = pagaron y se fueron; `AdminFinanceOverviewDto.refundedTotal` y `previous.refundedTotal` por fecha de devolución, `monthly[].month` en «dic 25» y `monthly[].refunded`, `reconciliation {paymentsWithoutInvoice, invoicesWithoutPayment}` (`{count,total}`), `addonsMrr` y `ai.revenueMonthly` sin IVA y solo de los que pagan; `AdminMrrForecastDto.insufficientHistory` (menos de 3 meses cerrados: no proyecta) y `basedOnMonths` = meses cerrados con datos; `AdminLtvDto.avgLtv` = ARPA / churn mensual medio del MRR (`null` sin datos), `avgMonthlyChurnPct` nuevo y `avgArpa` = MRR / que pagan; `GET /admin/business/trial-funnel` cuenta el pago atrasado como «pagan» y `conversionPct` incluye a los que pagaron y se fueron; `GET /admin/business/monthly-report` → 400 `month_in_future` y `refunded` por fecha de devolución; `businessAlerts` sin duplicados (uno por tipo y tenant, con su identificador). `?months=` que no es un número → el valor por defecto en Métricas, Finanzas y Negocio. Migración `20270223100000_mrr_snapshots_without_vat`: los snapshots guardados pasan a sin IVA.

> **2027-02-24 (mejoras de Métricas y Finanzas)** — Lectura: superadmin y soporte; el comercial no llega (403 `sales_not_allowed`). Escrituras: solo superadmin (403 `insufficient_super_admin_role`).
>
> - `GET /admin/metrics` añade `mrrBreakdown {total, planMonthly, planYearly, addons, discounts, monthlyTenants, yearlyTenants, discountedTenants}` (sin IVA; `discounts` = lo que se deja de ingresar al mes), `lastYear {mrr, payingTenants, signupsThisMonth, cancellationsThisMonth}` (mismo mes del año pasado, hasta el mismo momento) y `period.lastYear`.
> - `GET /admin/metrics/states?months=` → `{states[{state: trial|paying|past_due|read_only|churned|free, count, mrr, mrrKind: real|potential|lost}], evolution[{label, month, trial, paying, pastDue, readOnly, churned, payingMrr}]}`.
> - `GET /admin/metrics/retention` → cada cohorte añade `startMrr` y `revenueRetention` (% del MRR inicial conservado a los N meses del primer pago de cada cliente).
> - `GET /admin/metrics/mrr-forecast` añade `shortHistory` (menos de 6 meses cerrados), `scenarios[{key: prudent|expected|optimistic, label, newMrr, nrr, points}]` (percentil 25, media y percentil 75; `expected.points` = `points`) y `accuracy[{label, month, actual, forecasts[{monthsAhead, expected, prudent, optimistic, errorPct, withinRange}]}]` (previsiones guardadas en `mrr_forecasts` por el cron de snapshots, una vez al mes).
> - `GET /admin/metrics/concentration` → `{top1Pct, top5Pct, top10Pct, hhi, totalMrr, payingTenants, thresholdPct, overThreshold, top[]}`.
> - `GET /admin/metrics/revenue-series?by=plan|addon|source|rep&months=` → `{by, basis: mrr|collected, labels, months, series[{key, label, values}], note}` (400 `invalid_series`).
> - `GET /admin/metrics/breakdown?metric=&month=AAAA-MM&plan=&kind=` → `{metric, title, rows[{tenantId, name, slug, status, planName, mrr, detail}], totalMrr}`. `metric`: `paying`, `active`, `trial`, `past_due`, `read_only`, `suspended`, `cancelled`, `free`, `signups`, `churned` (sin `month`, todas las bajas), `plan` (con `plan`), `movement` (con `kind` = new|expansion|reactivation|contraction|churn), `cohort`, `concentration`. 400 `invalid_metric`, `invalid_kind`, `invalid_month`, `month_in_future`.
> - Anotaciones: `GET /admin/metrics/annotations`; `POST` `{date: AAAA-MM-DD, text}` (201), `PATCH /:id`, `DELETE /:id` (204; 404 `annotation_not_found`) — superadmin.
> - `GET /admin/finance?months=&vat=with|without` → `vatIncluded`, `lastYear {collectedTotal, refundedTotal, invoicedTotal}` y `reconciliation.payments[]` / `reconciliation.invoices[]` (uno a uno, los 200 más recientes). Sin IVA: cobros entre (1 + tipo) y lo facturado por su base.
> - `GET /admin/finance/cash-month` → `{label, collected, expectedRest, overdue, projected, target, collectedPct, projectedPct}` (con IVA; objetivo = `collectedTargetMonthly` de `PUT /admin/business/goals`, que también da `progress.collected`).
> - `GET /admin/finance/vat-quarterly?year=` → `{year, quarters[{quarter, label, invoices, base, tax, total, byRate[]}], totals}` (400 `invalid_year`).
> - `GET /admin/finance/margin?months=` → `{settings, monthly[{revenue, gatewayFees, aiCost, emailCost, salesCommissions, margin, marginPct}], totals, grossMarginPct, emailsSent, topTenants[], worstTenants[]}` (sin IVA).
> - `GET /admin/finance/acquisition?months=` → `{monthly[{newPaying, salesSpend, marketingSpend, cac}], totals, arpa, grossMarginPct, paybackMonths}`.
> - `GET/PUT /admin/finance/settings` (costes estimados: `stripeFeePct/Fixed`, `redsysFeePct/Fixed`, `sepaFeePct/Fixed`, `manualFeePct/Fixed`, `usdEurRate`, `emailCost`); `GET /admin/finance/marketing-spend?months=` y `PUT /admin/finance/marketing-spend/:month {amount, note?}` (400 `invalid_month`).
> - `GET /admin/finance/export.csv?kind=monthly|providers|vat|margin|reconciliation&months=&vat=&year=` (400 `invalid_export`) y `GET /admin/finance/report.pdf?months=&vat=`.
> - `PUT /admin/business/alerts/settings` acepta `concentrationPct` (1-100, 25 por defecto); aviso nuevo `concentration` cuando un cliente supera ese % del MRR.

> **2027-02-25 (revisión de Salud, Adopción y Uso)** — Último acceso del equipo = el más reciente entre `users.last_login_at` y `sessions.last_used_at` de sus usuarios activos (`common/team-activity.ts`) en Salud, «En riesgo», pruebas, «Hoy», la lista de tenants, la ficha, segmentos y comerciales; `GET /admin/tenants/:id/users` da el último acceso de cada usuario igual.
>
> - `GET /admin/tenants/health?segment=paying|trial|unpaid|exempt` (por defecto `paying`; otro valor → `paying`) → `AdminTenantsHealthDto {segment, counts {paying, trial, unpaid, exempt}, tenants[], snapshotAt}` (antes un array con todos). Cada `AdminTenantHealthDto` añade `segment`, `kind` (`health` | `activation`) y `trialEndsAt`; cada factor añade `counted` (un factor que no aplica va con `weight: 0` y su peso se reparte). Las pruebas llevan su activación (factores `facility`, `units`, `customer`, `contract`, `invoice`, `team`). `GET /admin/tenants/:id/health` devuelve la que le toque.
> - La salud ya no se guarda al consultar: la foto del mes la escribe la tarea `tenant-health.daily-snapshot` (03:20, worker).
> - `GET /admin/tenants/adoption`: sin las cuentas exentas; `monthlyPaid` pasa a ser lo que aporta al mes **sin IVA** (como el MRR; 0 si no paga), nuevos `inTrial`, `wouldPay`, `nearLimit`, `limitDetail` y `nearLimitCount`; `recommendedPlanPrice` sin IVA; `featureAdoption[].signal` (cómo se mide). Solo se recomiendan planes públicos y activos, con margen.
> - `GET /admin/usage?days=`: `days` no numérico → 30, más de 365 → 365; `ai.costUsd` con el precio de cada modelo (`common/ai-pricing.ts`) y `aiPricing.models[{model, calls, known, inputPerMTokUsd, outputPerMTokUsd}]`. El coste de la IA de `GET /admin/finance` (`ai`), el margen, `GET /admin/ai-settings/usage` y el aviso de gasto usan los mismos precios.

> **2027-02-26 (mejoras de Salud, Adopción y Uso)** — Lectura: superadmin y soporte; el rol comercial recibe 403 `sales_not_allowed`.
>
> - `GET /admin/health-settings` → `AdminPlatformHealthSettingsDto {clientWeights, trialWeights, dropAlertPoints, anomalyMultiplier, anomalyMinEmails, anomalyMinAiUsd, anomalyMinStorageMb, updatedAt}`; `PUT /admin/health-settings` (superadmin; cada grupo de pesos debe sumar 100 → 400).
> - `GET /admin/tenants/health` añade `mrrAtRisk {atRisk, dormant, total}` (sin IVA); cada `AdminTenantHealthDto` añade `planSlug`, `tags`, `salesRepId`, `salesRepName`, `mrr`, `wouldPay`, `activeDays30`, `activeUsers30`, `totalUsers`, `churnRisk` (`high`|`medium`|`low`, clientes), `payProbability` + `payProbabilityLevel` y `trialDaysLeft` (pruebas), `mainDrag {key, label, lostPoints, detail, action {kind, label, followupTitle}}` y `sparkline` (8 semanas).
> - `GET /admin/tenants/:id/health/history` → `{tenantId, monthly[], daily[], biggestDrop}` (12 meses y 90 días; 404 `tenant_not_found`).
> - `GET /admin/tenants/adoption`: cada función añade `uses30`, `uses90` (null si se mide por configuración) y `paidAddon`; cada tenant `status`, `tags`, `salesRepId`, `salesRepName`, `paidUnused[]` y `paidUnusedMonthly`; `featureAdoption[]` añade `uses30Total` e `intensityUnit`; total `paidUnusedCount`.
> - `GET /admin/adoption/candidates` → `{candidates[{tenantId, name, slug, status, planSlug, planName, salesRepId, salesRepName, tags, monthlyPaid, reasons[{kind: taps_limit|near_limit|outside_plan|interest, detail}], suggestions[{type: plan|addon, id, slug, name, extraMonthly, trialable}], estimatedExtraMonthly, lastOfferAt}], totalEstimatedMonthly}`. Interés = 2 o más entradas en 30 días en una función que no tiene.
> - `GET /admin/adoption/insights` → `{plans, matrix[{feature, label, byPlan{slug: {using, withAccess}}, using, withAccess}], retention[{feature, label, usedCount, notUsedCount, usedChurnPct, notUsedChurnPct, enoughData}], rarelyUsed[], churnedLast12m}`.
> - `GET /admin/usage`: cada fila añade `planSlug`, `planName`, `status`, `tags`, `salesRepId`, `salesRepName`, `whatsapp {messages}`, `aiByModel[{model, calls, costUsd}]`, `storage.byBucket`, `margin {revenue, costs, margin, marginPct} | null` (los meses del periodo, como Finanzas) y `anomalies[{kind: emails|ai|storage, detail}]`; totales `anomalyCount` y `marginMonths`.
> - `GET /admin/usage/evolution?tenantId=&months=` (3-24, 12 por defecto) → `{tenantId, months[{month, label, emails, whatsapp, aiCalls, aiCostUsd, storageBytes}], storageForecast[{month, label, bytes}], storageMonthlyGrowth}`.
> - `POST /admin/tenants/bulk-followups {tenantIds (1-500), title, note?, dueDate (AAAA-MM-DD), assignedToId?}` (también soporte) → `{created, skipped}`.
> - `/admin/saved-views` admite `page=health|adoption|usage`.
> - Avisos de negocio nuevos: `health_drop` y `usage_anomaly`.

> **2026-10-30 (mejoras de Cobros)** — `POST /admin/billing/receivables/:tenantId/remind` (superadmin; aviso de impago a demanda, no cuenta como paso del escalado; 400 `nothing_overdue`) → `{recipients}`. `POST /settings/saas-billing/redsys/redirect` acepta `months` (1-12) y `TenantRedsysPaymentOptionsDto.monthsOwed`; con el cobro automático (`redsys`) el importe incluye los extras que no van por Stripe. `AdminAtRiskTenantDto.owedAmount/owedPeriods` en los impagos de «Hoy» y «En riesgo». `AdminCalendarChargeDto.state` gana `retry` (+ `attempt`). `PlatformSepaSettingsDto.autoPrepare` (y en el `PUT`), `PlatformSepaRemittanceDto.collectedCount/bouncedCount/automatic`. Avisos al super admin: `platform_billing.past_due`, `platform_billing.mode_mismatch`, `platform_sepa.remittance_prepared`, `platform_sepa.remittance_unconfirmed`.

> **2026-10-30 (revisión de Cobros)** — `AdminOverdueDto` (en `/admin/billing/receivables` y `/admin/tenants/:id/account`) gana `periods` (cuotas vencidas sin pagar) y `periodAmount` (una cuota); `amount` es la suma. `since` es el mismo que usa el escalado (con Stripe, el inicio del periodo cuyo cobro falló). `receivables.total` y el «vencido» de `/admin/finance/forecast` no cuentan lo que ya va en una remesa SEPA (`overdue.sepaInProgress`). `POST /admin/tenants/:id/change-plan` a un plan gratis deja la suscripción `active` si estaba `past_due`.

> **2026-10-29 (funcionalidades)** — `GET /admin/business/trial-funnel?months=` (embudo de pruebas por mes de alta), `GET/PUT /admin/business/goals` (objetivos; escribir = superadmin), `GET /admin/business/alerts` + `PUT /admin/business/alerts/settings` (avisos de negocio y umbrales; superadmin), `GET /admin/business/tenants/:id` (ficha de negocio), `GET /admin/business/monthly-report?month=AAAA-MM&format=json|csv|pdf` (400 `invalid_month`), `GET /admin/finance/forecast` (previsión de cobros a 30/60/90 días). `?months=` (1-24) en `/admin/metrics`, `/admin/metrics/mrr-movements`, `/retention` y `/ltv`; `AdminMetricsDto.period {months, current, previous}` y `AdminFinanceOverviewDto.previous`. `GET /admin/today` → `businessGoals`. La salud tiene 6 factores (`portal`, `support` nuevos) y `trend`.

> **2026-10-29 (textos legales)** — `GET /public/landing/:slug/legal/condiciones-contratacion` (Condiciones Generales de Contratación) y `terms` en `GET/PATCH /settings/tenant/web-legal` (`texts.terms`, `generated["condiciones-contratacion"]`).

> **2026-10-29 (textos legales)** — Aceptación obligatoria: `POST /public/move-in/sign/:token` exige `generalTermsHash` (400 `general_terms_required`, 409 `general_terms_changed`); `ContractSignViewDto.generalTerms {title, url, hash, accepted}`; `POST /public/move-in/sign/:token/general-terms {generalTermsHash}` (contrato firmado antes de pagar); `POST …/payment` → 409 `general_terms_required` sin aceptarlas; `GET /contracts/:id/general-terms` y `generalTermsHash` en `POST /contracts/:id/sign` (firma del inquilino en el local); `ContractSigningRecordDto.generalTerms[]`; `GET /settings/tenant/web-legal/versions` (`settings:read`) y `/versions/:id` (`contracts:read`). Área de clientes: `PortalInvoiceDto.generalTerms` (`{contractId,title,url,hash,accepted}` o null) en el primer pago de un contrato sin aceptarlas; `POST /portal/me/contracts/:id/general-terms {generalTermsHash}` (404 si no es suyo, 409 `general_terms_changed`); `POST /portal/me/invoices/:id/charge`, `/offline-payment` y `/redsys-redirect` (también con `extraInvoiceIds`) → 409 `general_terms_required` (`details.contractIds`) sin ella. `GET /public/landing/:slug/legal/condiciones-contratacion` (Condiciones Generales de Contratación) y `terms` en `GET/PATCH /settings/tenant/web-legal` (`texts.terms`, `generated["condiciones-contratacion"]`).

> **2026-10-29** — Negocio del panel admin: `GET /admin/metrics` añade `payingTenants` y `trialsEndedThisMonth {ended, converted, toFree, churned}`; el MRR solo cuenta suscripciones activas de tenants vivos y las bajas son cancelados o suspendidos por `canceledAt` (anonimizados incluidos). `GET /admin/finance` pasa a netos: `collectedTotal`, `refundedTotal`, `disputedTotal`, `bySource {stripe, sepa, redsys, manual}` y `monthly[]` con esas cuatro series (se quitan `stripeTotal`/`manualTotal`); `invoicedTotal` sin las facturas sustituidas. `GET /admin/metrics/payment-retries` añade `bySource` (Stripe, adeudos SEPA devueltos, Redsys automático). `GET /admin/usage` → `ai.ownKeyCalls` (no entran en `costUsd`). `GET /admin/tenants/adoption` → `monthlyPaid`, `recommendedPlanPrice` y límites con los extras de capacidad.

> **2026-09-26** — `GET /admin/today` añade `failedWebhooks` (tenants con entregas de webhook `failed` en los últimos 7 días, con nº de fallos y último error). Las agregaciones pesadas del admin (`/admin/metrics`, `/admin/metrics/retention`, `/admin/metrics/ltv`, `/admin/tenants/health`, `/admin/tenants/adoption`) se cachean 60 s en memoria por proceso.

### Endpoints — SaaS billing (tenant paga el SaaS)

| Metodo | Ruta                              | Auth       | Roles | Descripcion                                         |
| ------ | --------------------------------- | ---------- | ----- | --------------------------------------------------- |
| GET    | `/settings/saas-billing`          | SI         | owner | Estado de la suscripcion + plan actual + portal URL |
| POST   | `/settings/saas-billing/checkout` | SI         | owner | Body `{priceId}`. Devuelve URL Stripe Checkout      |
| POST   | `/settings/saas-billing/portal`   | SI         | owner | Devuelve URL Customer Portal Stripe                 |
| POST   | `/webhooks/stripe/saas`           | HMAC       | —     | Webhook Stripe Billing (suscripciones + invoices)   |
| GET    | `/subscription-plans`             | —          | —     | Catalogo publico                                    |
| GET    | `/subscription-plans/admin`       | AdminGuard | —     | Gestion admin                                       |
| POST   | `/subscription-plans/admin`       | AdminGuard | —     | Crea plan                                           |
| PATCH  | `/subscription-plans/admin/:id`   | AdminGuard | —     | Actualiza plan                                      |
| DELETE | `/subscription-plans/admin/:id`   | AdminGuard | —     | Archiva plan                                        |

Revisión de los planes (2026-11-18): los extras de la plataforma (`isSystem`) devuelven 400 `addon_managed_by_platform` en quitar, suspender, reactivar, cambiar el cobro y cobrar desde «Hoy»; de ellos solo se editan nombre, descripción y precio. `POST /admin/quote` → 400 `yearly_not_available` (plan por trastero) y `addon_not_for_plan`. Cambiar de plan desde el admin al plan gratuito o darlo de alta → 400 `plan_retired`. `TenantBillingSummaryDto.planSlug`, `AdminChangePlanPreviewDto.extraUnits` (y `redundantAddons` incluye los que el plan nuevo no admite), `TenantLifecycleRunResultDto.readOnlySuspended`. En solo lectura también se admiten `DELETE /users/:id`, `POST /invitations/:id/revoke`, `/platform-legal-pending/*` y `POST /settings/data-export`.

Prueba y fin del plan gratuito (2026-11-18): `POST /auth/register` admite `planSlug` (`basic`, `starter`, `pro`, `administrador`; uno oculto o desactivado cae en Starter). Con la suscripción `expired` (prueba o plan gratuito terminados sin pagar) cualquier escritura del panel salvo Suscripción, soporte, perfil, autenticación y avisos da 403 `subscription_expired_read_only`; `GET /settings/billing-status` lleva `expired`. `TenantLifecycleRunResultDto.freePlanMoves`. Correos automáticos nuevos `free_plan_notice` y `free_plan_ended`; `trial_ending` y `trial_ended` ganan `{plan}`, `{fecha}` e `{importe}`.

Plan por trastero (2026-11-18): los planes llevan `includedUnits` (trasteros incluidos en la cuota; null = precio fijo) y `extraUnitPrice` (precio de cada trastero más, el del extra `addon-extra-units`); se editan con `includedUnits` en el alta y edición. Los extras llevan `planSlugs` (planes en los que se pueden tener; vacío = todos), `maxQuantity` e `isSystem` (los calcula la plataforma: asignarlos, contratarlos o quitarlos a mano → 400 `addon_managed_by_platform`). Contratar o asignar un extra fuera de su plan → 400 `addon_not_for_plan`; por encima de su cantidad → 400 `addon_max_quantity`. Al llegar al tope de trasteros en Pro (1.000) o Administrador (1.500), el 403 `units_limit_reached` dice que se le contactará con un precio a medida y se crea un aviso del super admin `tenant.custom_pricing`. Cambiar de plan (autoservicio) sin caber en los límites del plan nuevo → 400 `plan_limits_exceeded` con `details.over`; pago anual de un plan por trastero → 400 `yearly_not_available`. `TenantAddonDto.isSystem`. `POST /admin/quote` admite `units` (con un plan por trastero añade la línea «Trasteros de más»).

Catálogo (PR B): `GET /subscription-plans/admin` lleva `tenantCount`, `payingTenants`, `mrr` e `isPublic`; `GET /subscription-plans/admin/:id/price-preview?priceMonthly=` → `PlanPricePreviewDto`; desactivar un plan con tenants → 409 `plan_in_use`; un plan oculto (`isPublic: false`) no sale en `GET /subscription-plans` y el checkout o el cambio de plan del tenant dan 400 `plan_not_available`. `GET /admin/catalog/price-history?kind=plan|addon&itemId=`. Extras: `priceTiers` en el alta/edición y `tenantCount` en la lista. Cupones: `planIds`, `durationMonths`, `oncePerTenant`, `validFrom`, `stripeReady`; `GET /admin/coupons/:id/redemptions`, `DELETE /admin/coupons/:id` (409 `coupon_in_use` si se ha usado); errores nuevos `coupon_not_yet_valid`, `coupon_not_for_plan`, `coupon_already_used`; `couponCode` en `POST /settings/saas-billing/checkout` y `/change-plan` (400 `coupon_not_in_stripe`). Propuestas: `POST /admin/tenants/:id/quote-offers` devuelve `offerId`; `GET /admin/quote-offers?tenantId=` → `PlatformQuoteOffersDto`; `PATCH /admin/quote-offers/:id {status}`. Comisión: `GET /admin/payment-settings/tenants`, `PUT /admin/payment-settings/tenants/:tenantId {applicationFeePct|null}`, `GET /admin/payment-settings/fee-report?months=`.

Planes: 400 `slug_taken` (slug repetido), `plan_slug_locked` (renombrar un plan sembrado) y `plan_required` (desactivar `free` o `starter`). Cupones de plataforma: un porcentaje por encima de 100 → 400 (`coupon_percentage_too_high` al editar). En `POST /admin/tenants/:id/saas-payments/manual` con `couponCode`, `amount` es el precio de lista y el pago se registra por el neto. Asignar o probar un extra desactivado (que el tenant no tenía) → 400 `addon_not_available`. `POST /admin/quote` anual con un plan sin precio anual cobra 12 cuotas.

### Codigos `code` (Fase 8)

| `code`                            | Cuando                                                                |
| --------------------------------- | --------------------------------------------------------------------- |
| `super_admin_credentials_invalid` | Email o password incorrectos.                                         |
| `super_admin_not_found`           | ID invalido.                                                          |
| `super_admin_inactive`            | Cuenta deshabilitada.                                                 |
| `impersonation_token_expired`     | TTL 1h agotado.                                                       |
| `support_ticket_not_found`        | ID invalido o tenant ajeno.                                           |
| `support_ticket_status_invalid`   | Transition fuera del state machine.                                   |
| `subscription_plan_inactive`      | Checkout sobre plan archivado.                                        |
| `tenant_subscription_required`    | Llamadas que requieren suscripcion activa con tenant sin suscripcion. |

## Hardening pre-MVP (Fase 9A)

Endpoints anadidos sobre el panel super admin para hardening de seguridad antes de vender. Ver ADR-007.

### Endpoints — 2FA TOTP super admin

| Metodo | Ruta                                        | Auth       | Descripcion                                                           |
| ------ | ------------------------------------------- | ---------- | --------------------------------------------------------------------- |
| POST   | `/admin/auth/2fa/setup`                     | AdminGuard | Genera TOTP secret pending + QR data URL                              |
| POST   | `/admin/auth/2fa/verify`                    | AdminGuard | Body `{code}`. Activa 2FA y devuelve `{recoveryCodes}` (una sola vez) |
| POST   | `/admin/auth/2fa/disable`                   | AdminGuard | Body `{password}`. Revoca todas las sesiones + borra cookie           |
| POST   | `/admin/auth/2fa/recovery-codes/regenerate` | AdminGuard | Devuelve `{recoveryCodes}` nuevos (una sola vez)                      |
| POST   | `/admin/auth/2fa/challenge`                 | Public     | Body `{pendingToken, code}` (TOTP 6 digitos o recovery `XXXX-XXXX`)   |
| GET    | `/admin/auth/2fa/status`                    | AdminGuard | `{enabled, enrolledAt, recoveryCodesRemaining}`                       |

### Refresh cookie httpOnly

- Cookie `super_admin_refresh` con `path=/admin`, `sameSite=strict`, `httpOnly`, `secure` segun `COOKIE_SECURE`.
- Rota en cada `POST /admin/auth/refresh`. Reuso de cookie ya rotada revoca **todas** las sesiones del admin.
- TTL configurable via env `SUPER_ADMIN_REFRESH_TTL_SECONDS` (default 604800 = 7d).

### Codigos `code` (Fase 9A)

| `code`                                  | Cuando                                |
| --------------------------------------- | ------------------------------------- |
| `super_admin_2fa_already_enabled`       | Setup sobre admin con 2FA activo.     |
| `super_admin_2fa_not_enabled`           | Verify/disable sobre admin sin 2FA.   |
| `super_admin_2fa_code_invalid`          | TOTP o recovery code incorrecto.      |
| `super_admin_2fa_pending_token_invalid` | pendingToken caducado/firma invalida. |
| `super_admin_refresh_invalid`           | Cookie ausente, expirada o ya rotada. |

## Veri\*Factu real (Fase 10)

Modulo `apps/api/src/modules/billing/aeat-client/` y `tenant-aeat-credentials.{service,controller}.ts`.

### Invariantes clave

- **Cada tenant** sube su PKCS#12 (FNMT/Camerfirma/ANCERT). Cifrado AES-256-GCM con `MASTER_ENCRYPTION_KEY`.
- **`AEAT_MODE=stub|sandbox|production`** selecciona implementacion. `stub` devuelve `accepted` sintetico. `sandbox`/`production` usan `RealAeatClient` con mTLS via `https.Agent`.
- **XML conforme al XSD AEAT**: SOAP envelope con `Cabecera/ObligadoEmision`, `RegistroAlta` (IDFactura, Desglose IVA, Encadenamiento, SistemaInformatico, TipoHuella=01, Huella SHA-256 uppercase).
- **Envíos en lotes con control de flujo** (2026-11-08, art. 16 de la Orden HAC/1177/2024): cola BullMQ `verifactu`, un trabajo por emisor (el negocio o un propietario) y hora de salida (`VerifactuDispatcher`, `jobId` `vf-<tenant>-<self|owner>-<ms>`). `VerifactuService.sendPending` manda lo pendiente del emisor en lotes de hasta 1.000 registros en el orden de la cadena (`RefExterna` = id de la factura), espera entre envíos el `TiempoEsperaEnvio` de la respuesta (60 s al principio; con 1.000 acumulados no espera) y reserva el emisor (`verifactu_emitters.lease_until`) para que dos envíos suyos no vayan a la vez. Un envío sin respuesta válida (red, tiempo agotado, `SoapFault`, 5xx) se repite con espera creciente hasta una hora (`retry_at`); `rejected` no se repite (decisión de la AEAT); un «duplicado» (3000) toma lo que la AEAT tiene registrado. Cada envío queda en `verifactu_submissions` con su CSV.
- **Registros por separado** (2026-11-08): cada registro de facturación (alta, subsanación o anulación) es una fila de `verifactu_records` con su huella, su lugar en la cadena del emisor y el XML **tal como se generó** (no se rehace al enviar con los datos de ahora). La factura conserva la huella y el QR de su alta; `aeat_status`, `aeat_csv` y `aeat_response` de la factura son los de su último registro (`VerifactuRecordsService.syncInvoices`). `RefExterna` = id del registro. La AEAT responde por registro; la consulta de estado da «Anulado» cuando el último registro es una anulación.
- **Reenvio manual**: `POST /billing/invoices/:id/resend-aeat {reason?}` → `{queued, invoiceId, subsanacion}`. Si el último registro no llegó (`pending`/`error`), vuelve a salir **el mismo**; si la AEAT lo **rechazó** o lo **aceptó con avisos**, se genera un **registro de subsanación** al final de la cadena (`Subsanacion=S`; `RechazoPrevio=X` si la AEAT nunca registró la factura, `S` si la tenía y rechazó la subsanación) o, si era una anulación, otra anulación; el anterior no se toca. Programa el envío de su emisor sin esperar al reintento de un fallo. 400 `already_accepted` (ya aceptada), `invoice_rectified` (sustituida o anulada con rectificativa: se corrige la rectificativa). Emitir en envío real (`AEAT_MODE` ≠ stub) exige NIF válido del emisor (400 `tenant_tax_id_required`) y, en facturas completas, NIF/NIE válido del cliente español (400 `customer_tax_id_required`).
- **Anular por error**: `POST /invoices/:id/void {reason}` (ver Facturas) genera el **registro de anulación** (`SinRegistroPrevio=S` si la AEAT no tenía la factura).
- **Incidencias** (art. 16.4): mientras un emisor tiene envíos sin respuesta, lo que queda pendiente se marca como incidencia y sale en envíos aparte con `Incidencia=S` en `RemisionVoluntaria`; `GET /billing/verifactu/alert` da cuántos y desde cuándo para el aviso del panel.
- **Renuncia** (art. 17): un negocio con registros en el año sigue en VERI\*FACTU hasta el 31 de diciembre; desactivarlo programa la baja (`tenants.verifactu_end_date`) y los envíos que salgan hasta entonces llevan `FechaFinVeriFactu`. El 1 de enero el cron `verifactu.renuncia` (00:20 Madrid, en el worker) lo apaga si la renuncia llegó a la AEAT por todos sus emisores; si no, sigue activado y avisa (`verifactu.renuncia_not_sent`).
- **Declaración responsable** (art. 13 del RD 1007/2023 y art. 15 de la Orden): `GET /v1/public/verifactu/declaration/pdf?version=` (público, 30/min; sin `version`, la de la versión en uso) devuelve el PDF (`attachment`); se genera una vez por versión y se guarda en memoria. 404 `declaration_not_found` si esa versión no tiene declaración. El texto sale de `verifactuDeclaration()` (shared `billing/verifactu-declaration.ts`, una entrada de `VERIFACTU_DECLARATIONS` por versión): la web lo enseña en `/declaracion-responsable` y en Configuración → Veri\*Factu.

### Veri\*Factu por negocio (2026-11-08)

Cada negocio activa el envío a la AEAT (`tenants.verifactu_enabled`, apagado por defecto). Apagado, `issue` emite sin huella, cadena, QR ni envío (`hash`, `chainSeq`, `qrCodeUrl` y `aeatStatus` a null) y sin las comprobaciones del envío real (NIF del emisor y del cliente, certificado). Activado, la primera factura abre la cadena del emisor (`PrimerRegistro`).

| Metodo | Ruta                                      | Permiso             | Descripcion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/billing/verifactu/settings`             | `invoices:manage`   | `VerifactuSettingsDto`: `enabled`, `enabledAt`, `lockedUntil` (AAAA-12-31 del año del último registro, si es este año: hasta entonces no se apaga), `renuncia` (`{endDate, communicatedAt, pendingEmitters}` con la baja programada; `communicatedAt` = cuándo llegó a la AEAT por todos los emisores), `platformMode`, `blockers` (lo que falta para activarlo: `{code, message, href}`), `pendingCount`, `rejectedCount`, `incidentCount` (pendientes por una incidencia), `lastError` (el último fallo, en palabras), `invoicingInHolded`, `lastSubmission` (el último envío) y `nextSendAt` (con facturas pendientes, cuándo sale el siguiente envío; null = ya) |
| GET    | `/billing/verifactu/alert`                | `invoices:read`     | `VerifactuAlertDto {unsentCount, since, lastError}`: lo que no ha podido salir por una incidencia (el aviso de la cabecera)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| GET    | `/billing/verifactu/submissions?limit=`   | `invoices:manage`   | Los últimos envíos a la AEAT (`VerifactuSubmissionDto[]`, 50 por defecto, máx. 200): fecha, emisor, facturas, registradas y rechazadas, resultado (`accepted`, `partially_accepted`, `rejected`, `error` = sin respuesta), CSV y espera pedida                                                                                                                                                                                                                                                                                                                                                                                                                       |
| PUT    | `/billing/verifactu/settings`             | `billing:configure` | `{enabled}`. Activar: 409 `verifactu_platform_not_ready` (producción con `AEAT_MODE=stub`), 400 `issuer_fiscal_data_required`, y con envío real 400 `tenant_tax_id_required` / `aeat_certificate_required`. Desactivar sin registros este año lo apaga; con registros, programa la baja para `lockedUntil` (sigue `enabled: true`). `{enabled: true}` con la baja programada la anula si aún no salió (409 `verifactu_renuncia_sent` si ya llegó a la AEAT)                                                                                                                                                                                                          |
| GET    | `/billing/invoices/:id/verifactu-records` | `invoices:read`     | `VerifactuRecordDto[]` de la factura en el orden de la cadena: `kind` (`alta`/`anulacion`), `subsanacion`, `rechazoPrevio`, `sinRegistroPrevio`, `status`, `csv`, `message` de la AEAT, `sentAt`, `reason`, `incident`, `simulated`                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`POST /billing/invoices/:id/resend-aeat` y `…/refresh-aeat-status` sobre una factura emitida sin Veri\*Factu → 400 `not_a_verifactu_record`. La reserva online solo exige un DNI/NIE válido (400 `invalid_tax_id`) si el negocio tiene Veri\*Factu activado y la plataforma envía de verdad. `GET /settings/tenant/health` añade `verifactu_off` y `aeat_missing` pasa a ser un error solo con Veri\*Factu activado.

### Endpoints — Credenciales AEAT del tenant

| Metodo | Ruta                           | Auth | Roles          | Descripcion                                                                          |
| ------ | ------------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------ |
| POST   | `/billing/aeat-credentials`    | SI   | owner          | `multipart/form-data` con `file` (.p12/.pfx) + `password` + `environment` (max 50KB) |
| GET    | `/billing/aeat-credentials/me` | SI   | owner, manager | Metadata: CN, NIF, issuer, validFrom, validTo, environment, uploadedAt               |
| DELETE | `/billing/aeat-credentials/me` | SI   | owner          | Body `{reason}`. Revoca (`revokedAt`, `revokedReason`)                               |

### Endpoints — Reenvio factura

| Metodo | Ruta                                | Auth | Roles          | Descripcion                                                                                                                                                                                 |
| ------ | ----------------------------------- | ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/billing/invoices/:id/resend-aeat` | SI   | owner, manager | `{reason?}`. El mismo registro si no llegó; subsanación si la AEAT lo rechazó o lo aceptó con avisos (202 `{queued, invoiceId, subsanacion}`); 400 `already_accepted` / `invoice_rectified` |

### Codigos `code` (Fase 10)

| `code`                         | Cuando                                             |
| ------------------------------ | -------------------------------------------------- |
| `invalid_certificate_password` | PKCS#12 no abre con la contrasena proporcionada.   |
| `invalid_certificate_format`   | Archivo no parseable como PKCS#12.                 |
| `certificate_expired`          | `notAfter <= now`.                                 |
| `certificate_missing_nif`      | No se encontro NIF/CIF/NIE en el subject del cert. |
| `aeat_credential_not_found`    | GET/DELETE sin credencial activa.                  |
| `tenant_no_aeat_credential`    | Envio a AEAT sin credencial subida.                |
| `invoice_draft_not_sendable`   | Resend sobre factura en draft.                     |

### BullMQ + colas Fase 10

| Cola        | Job            | Descripcion                                                               |
| ----------- | -------------- | ------------------------------------------------------------------------- |
| `verifactu` | `send-to-aeat` | POST mTLS al endpoint AEAT con cert tenant. Retry 3× exponencial 60s base |

## Compliance + observabilidad (Fase 11)

Modulos `apps/api/src/modules/{security-events,billing}`. Cierre del MVP en
materia de trazabilidad sin tenant, rotacion de credenciales AEAT, CSP en
panel autenticado y rectificativas Veri\*Factu por diferencias.

### Invariantes clave

- **`security_events` global**: tabla SIN `tenant_id` y sin RLS. Almacena
  intentos de login/registro fallidos cuando todavia no hay tenant context
  (email no existe, tenant no existe, throttled, etc.). Acceso solo via
  `PrismaAdminService`. `SecurityEventsService.record()` es **defensivo**:
  cualquier error al persistir se loguea pero no rompe el flujo de auth.
- **`tenant_aeat_credentials` historico**: se elimina la restriccion
  `UNIQUE` sobre `tenant_id`. La credencial activa es la unica fila del
  tenant con `revoked_at IS NULL`. El upload nuevo hace
  `updateMany {revokedAt: null}` + `create new` dentro de un
  `$transaction`. Permite auditar todas las rotaciones.
- **CSP enforce**: el panel autenticado de `apps/web` envia el header
  `Content-Security-Policy` (no `Report-Only`) configurado en
  `next.config.mjs`. Las violaciones se reportan a `POST /api/csp-report`.
  La ruta `/widget/:path*` mantiene `frame-ancestors *` (embeds externos).
- **Rectificativas Veri\*Factu R1-R5**: nuevos campos en `invoices`
  (`invoice_type`, `rectifies_invoice_id`, `rectification_reason`,
  `correction_method`). El XML AEAT incluye `<TipoRectificativa>I</...>`
  (`I` = por diferencias, default Fase 11) y `<FacturasRectificadas>` con
  la lista de IDFactura rectificadas. La sustitucion (`S`) llega en
  Fase 13.

### Endpoints — Security events (super admin)

| Metodo | Ruta                     | Auth       | Descripcion                                                                                                                |
| ------ | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/security-events` | AdminGuard | Filtros `?eventType=&emailAttempted=&ipAddress=&fromDate=&toDate=&cursor=&limit=` (email parcial, IP exacta). Solo lectura |

Eventos registrados (campo `event_type`): `login_failed_email_not_found`,
`login_failed_tenant_not_found`, `login_failed_wrong_password`,
`login_failed_throttled`, `register_throttled`,
`password_reset_throttled`, `invitation_token_invalid`,
`refresh_token_reuse`.

Cron diario `0 3 * * *` borra eventos con `created_at < now() - interval '90 days'`.

### Endpoints — Historial de credenciales AEAT

| Metodo | Ruta                                | Auth | Roles          | Descripcion                                                                 |
| ------ | ----------------------------------- | ---- | -------------- | --------------------------------------------------------------------------- |
| GET    | `/billing/aeat-credentials/history` | SI   | owner, manager | Lista cronologica de todas las credenciales (activa + revocadas) del tenant |

`GET /billing/aeat-credentials/me` sigue existiendo y devuelve la activa.

### Endpoints — CSP report

| Metodo | Ruta              | Auth | Descripcion                                                                       |
| ------ | ----------------- | ---- | --------------------------------------------------------------------------------- |
| POST   | `/api/csp-report` | NO   | Recibe violaciones CSP del navegador (formato `application/csp-report`). Logueado |

### Endpoints — Rectificativas Veri\*Factu

| Metodo | Ruta                    | Auth | Roles          | Descripcion                                                                                               |
| ------ | ----------------------- | ---- | -------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/invoices/:id/rectify` | SI   | owner, manager | Crea factura rectificativa R1-R5 a partir de una emitida. Encadena hash y la envia AEAT en su propia cola |

**Body:**

```json
{
  "rectificationType": "R1",
  "reason": "Error en NIF del destinatario",
  "items": [{ "description": "...", "quantity": 1, "unitPrice": -50, "taxRate": 21 }],
  "correctionMethod": "by_differences"
}
```

- `rectificationType` ∈ `R1`, `R2`, `R3`, `R4`, `R5` (segun causa AEAT).
- `correctionMethod` default `by_differences` (Fase 11). La opcion
  `by_substitution` llega en Fase 13.

### Codigos `code` (Fase 11)

| `code`                              | Cuando                                                        |
| ----------------------------------- | ------------------------------------------------------------- |
| `invoice_not_rectifiable`           | La factura origen no esta `issued`/`paid`/`overdue`.          |
| `invoice_already_rectified`         | La factura ya tiene una rectificativa emitida vigente.        |
| `rectification_type_invalid`        | `rectificationType` fuera de R1-R5.                           |
| `rectification_reason_required`     | Falta el motivo (obligatorio AEAT).                           |
| `correction_method_invalid`         | Valor distinto a `by_differences`/`by_substitution`.          |
| `aeat_credentials_history_disabled` | Tenant sin credenciales jamas (no hay historial que mostrar). |

## Hardening operacional (Fase 12)

Modulos `apps/api/src/modules/{auth,security-alerts,admin,tenants}/`.
Refuerzo final pre-deploy: forzar 2FA para roles privilegiados, alertas
de fuerza bruta y audit log dedicado de acciones del super admin.

### Invariantes clave

- **Forzar 2FA owner/manager**: nueva columna
  `tenants.require_two_factor_for_managers BOOLEAN DEFAULT false`. Cuando
  un tenant la activa, los users con role `owner`/`manager` que aun no
  tengan 2FA quedan **bloqueados** tras login y deben enrolarse antes de
  recibir tokens. El login devuelve un `enrolmentToken` corto en lugar
  de access/refresh.
- **Alertas brute-force**: `SecurityAlertsService.scanAndAlert()` agrega
  `security_events` y, si encuentra >5 fallos en 15 min para el mismo
  email o IP, envia un email a `SECURITY_ALERT_EMAIL`. Dedup en memoria
  para no spamear. Cron `*/5 * * * *`.
- **`super_admin_audit_logs` global**: tabla sin `tenant_id` y sin RLS.
  Registra acciones del super admin (login, 2FA, impersonation, suspension
  de tenants). `SuperAdminAuditService.record()` es defensivo (no rompe
  flujos si el insert falla).

### Endpoints — Forzar 2FA en enrolment

Los endpoints publicos `/auth/2fa/enrol-required/*` se activan solo cuando
el login devuelve un `enrolmentToken`. No requieren JWT, lo identifica el
token.

| Metodo | Ruta                              | Auth | Throttle  | Descripcion                                                                                                            |
| ------ | --------------------------------- | ---- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/2fa/enrol-required/setup`  | NO   | 60/min/IP | Body `{enrolmentToken}`. Devuelve `{otpauthUri, secretBase32}` (mismo flujo que `/auth/2fa/setup`)                     |
| POST   | `/auth/2fa/enrol-required/verify` | NO   | 5/min/IP  | Body `{enrolmentToken, code}`. Activa 2FA, emite cookie refresh + access. Devuelve `{recoveryCodes, accessToken, ...}` |

Respuesta de `POST /auth/login` cuando aplica el forzado:

```json
{
  "requires2faEnrolment": true,
  "enrolmentToken": "eyJ...",
  "expiresIn": 600
}
```

### Endpoints — Configuracion de seguridad del tenant

| Metodo | Ruta                        | Auth | Roles | Descripcion                                                                                                |
| ------ | --------------------------- | ---- | ----- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/settings/tenant/security` | SI   | owner | Lee `{ requireTwoFactorForManagers }`                                                                      |
| PATCH  | `/settings/tenant/security` | SI   | owner | Body `{requireTwoFactorForManagers}`. Emite audit `tenant.security.require_2fa_changed`                    |
| GET    | `/settings/tenant/billing`  | SI   | —     | Lee `{ autoChargeOnIssue }`                                                                                |
| PATCH  | `/settings/tenant/billing`  | SI   | owner | Body `{autoChargeOnIssue}`. Cobro automatico al emitir factura. Audit `tenant.billing.auto_charge_changed` |

### Endpoints — Brute-force scan + super admin audit log

| Metodo | Ruta                          | Auth       | Descripcion                                                                       |
| ------ | ----------------------------- | ---------- | --------------------------------------------------------------------------------- |
| POST   | `/admin/security-alerts/scan` | AdminGuard | Dispara el scan manualmente fuera del cron                                        |
| GET    | `/admin/audit-logs`           | AdminGuard | Filtros `?superAdminId=&action=&targetTenantId=&fromDate=&toDate=&cursor=&limit=` |
| GET    | `/admin/queues`               | AdminGuard | Counts por cola BullMQ + ultimos 10 jobs fallidos por cola (motivo, intentos)     |

Acciones registradas en `super_admin_audit_logs`:
`admin.login.success`, `admin.login.failed`, `admin.2fa.enabled`,
`admin.2fa.disabled`, `admin.2fa.recovery_codes_regenerated`,
`admin.2fa.challenge.success`, `admin.2fa.challenge.failed`,
`admin.tenant.impersonate`, `admin.tenant.suspended`,
`admin.tenant.reactivated`, `admin.tenant.trial_extended`.

### Codigos `code` (Fase 12)

| `code`                                 | Cuando                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `two_factor_enrolment_required`        | Login con rol privilegiado y `require_two_factor_for_managers=true`.     |
| `enrolment_token_invalid`              | `enrolmentToken` caducado o firma invalida.                              |
| `enrolment_already_completed`          | El user ya activo 2FA antes de consumir el token.                        |
| `tenant_security_settings_not_allowed` | Cualquier role distinto de `owner` que toca `/settings/tenant/security`. |

## Robustez tecnica + F2 + sustitucion (Fase 13)

Modulos `apps/api/src/{main.ts, modules/billing}`. Cubre versionado de
URLs, OpenAPI/Swagger publico (gated), factura simplificada F2 y
rectificativas por sustitucion.

### Invariantes clave

- **Versionado `/v1/`**: `app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })`.
  TODAS las rutas viven bajo `/v1/...`. Las rutas legacy responden
  **`308 Permanent Redirect`** preservando metodo HTTP y body al destino
  versionado. Excepciones marcadas `VERSION_NEUTRAL`: `/health`,
  `/webhooks/*`, `/public/widget/*`, `/api/docs`, `/api/docs-json`,
  `/api/csp-report`.
- **OpenAPI + Swagger UI**: montado en `GET /api/docs` (UI) +
  `GET /api/docs-json` (schema). En produccion solo si
  `OPENAPI_ENABLED=true` (debe estar detras de auth/VPN en Nginx Proxy
  Manager).
- **F2 simplificadas**: `invoices.customer_id` ahora **NULLABLE**. Crear
  un invoice con `invoiceType='F2'` permite omitir `customerId`. Limites
  AEAT: total ≤ 400€ por defecto; ≤ 3000€ si se aporta
  `simplifiedJustification` ∈ `reparation`, `transport`, `restaurant`,
  `parking`, `other`. El XML emite
  `<FacturaSinIdentifDestinatarioArt61d>S</...>` cuando no hay recipient.
- **F1 sigue obligando `customerId`**: ausente devuelve
  `400 customer_required`.
- **Rectificativas por sustitucion**: `correctionMethod='by_substitution'`
  emite XML con `<TipoRectificativa>S</TipoRectificativa>` + bloque
  `<ImporteRectificacion>` con `BaseRectificada`/`CuotaRectificada`.

### Convencion `/v1/` aplicada a todos los modulos previos

Las tablas de endpoints de Fases 1-12 muestran rutas sin prefijo por
claridad historica; el servidor sirve cada una bajo `/v1/...`. Ejemplos:

- `POST /auth/login` → `POST /v1/auth/login` (legacy redirige 308).
- `GET /invoices` → `GET /v1/invoices`.
- `POST /webhooks/stripe` se queda **sin prefijo** (URL registrada en
  Stripe dashboard).

### Endpoints — OpenAPI

| Metodo | Ruta             | Auth | Descripcion                     |
| ------ | ---------------- | ---- | ------------------------------- |
| GET    | `/api/docs`      | NO\* | Swagger UI                      |
| GET    | `/api/docs-json` | NO\* | Schema crudo `application/json` |

`*` Gated por `OPENAPI_ENABLED=true` en prod; siempre en dev/test.

### Endpoints — Facturas F2 + rectificativas por sustitucion

`POST /v1/invoices` (Fase 4) ahora acepta el discriminador `invoiceType`:

```json
{
  "invoiceType": "F2",
  "customerId": null,
  "simplifiedJustification": "parking",
  "items": [{ "description": "Venta libre", "quantity": 1, "unitPrice": 12, "taxRate": 21 }]
}
```

`POST /v1/invoices/:id/rectify` (Fase 11) acepta tambien:

```json
{
  "rectificationType": "R1",
  "reason": "...",
  "items": [...],
  "correctionMethod": "by_substitution"
}
```

### Codigos `code` (Fase 13)

| `code`                             | Cuando                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `customer_required`                | `invoiceType='F1'` sin `customerId`.                                         |
| `f2_amount_limit_exceeded`         | F2 con total > 400€ sin justificacion o > 3000€ con justificacion.           |
| `simplified_justification_invalid` | Valor fuera de la whitelist.                                                 |
| `correction_method_invalid`        | Tambien aplica aqui: `by_substitution` requiere `invoice_type` rectificable. |

## Integraciones — API keys y webhooks salientes (Fase 14)

Modulos `apps/api/src/modules/{api-keys,webhooks-outgoing,integrations}/`.
Introduce credenciales programaticas para tenants y notificaciones HTTP
firmadas a sistemas externos.

### Invariantes clave

- **API keys** (tabla `api_keys`, RLS por tenant): plaintext con formato
  `sk_live_<tenantId>.<secret>`. Solo el hash argon2id del `secret` se
  persiste. `key_prefix` guarda los primeros 12 chars para mostrar en UI
  ("sk_live_abcd..."). `scopes` es `text[]` (whitelist tipo
  `invoices:read`, `customers:write`, `*`). Soft revoke con `revoked_at`.
- **`ApiKeyGuard`**: extrae `Authorization: Bearer sk_live_*`, hace lookup
  por prefix + verify argon2id del secret. Actualiza `last_used_at`. Solo
  aplicado a `/integrations/*`.
- **Webhooks** (tabla `webhooks`, RLS por tenant): `url`, `events` (array
  de strings dentro de la whitelist), `secret` cifrado AES-256-GCM con
  `CryptoService`, `is_active`. Eventos permitidos: `invoice.issued` (al emitir; los suscritos al antiguo `invoice.created` lo siguen recibiendo con ese nombre),
  `invoice.paid`, `invoice.overdue`, `contract.signed`, `lead.created`.
- **HMAC**: cada delivery firma `${ts}.${body}` con HMAC-SHA-256. Header
  `X-Storageos-Signature: t=<unix_ts>,v1=<hmacSha256Hex>`. Headers extra:
  `X-Storageos-Event: <eventType>`, `X-Storageos-Delivery: <deliveryId>`.
- **Retry**: cola BullMQ `webhooks` job `deliver` con `attempts: 3,
backoff: exponential 60s`. Si HTTP retorna 2xx → `status='success'`.
  Si lanza error tecnico o status ≥ 500 → throw → BullMQ reintenta. Tras
  3 intentos fallidos → `status='failed'` y no se reintenta hasta
  reenvio manual.
- **`webhook_deliveries`** (RLS por tenant): persiste cada intento con
  `payload`, `signature`, `attempts`, `status`, `status_code`,
  `response_body`, `error_message`, `scheduled_for`, `delivered_at`.
  Indices `(tenant_id, status)` y `(webhook_id, created_at desc)`.

### Endpoints — API keys

| Metodo | Ruta                     | Auth | Roles          | Descripcion                                                                                       |
| ------ | ------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/settings/api-keys`     | SI   | owner, manager | Lista las API keys del tenant (sin secret; solo `keyPrefix`, `scopes`, `lastUsedAt`, `revokedAt`) |
| POST   | `/settings/api-keys`     | SI   | owner          | Body `{name, scopes}`. Devuelve `{apiKey}` plaintext **una sola vez**                             |
| DELETE | `/settings/api-keys/:id` | SI   | owner          | Revoca (soft, `revoked_at`)                                                                       |

### Endpoints — Webhooks salientes

| Metodo | Ruta                                   | Auth | Roles          | Descripcion                                                                |
| ------ | -------------------------------------- | ---- | -------------- | -------------------------------------------------------------------------- |
| GET    | `/settings/webhooks`                   | SI   | owner          | Lista webhooks del tenant                                                  |
| POST   | `/settings/webhooks`                   | SI   | owner          | Body `{name, url, events[]}`. Genera secret y lo devuelve **una sola vez** |
| PATCH  | `/settings/webhooks/:id`               | SI   | owner          | Edita `name`, `url`, `events`, `isActive`                                  |
| DELETE | `/settings/webhooks/:id`               | SI   | owner          | Revoca (soft, `revoked_at`)                                                |
| POST   | `/settings/webhooks/:id/rotate-secret` | SI   | owner          | Genera secret nuevo; devuelve plaintext una sola vez                       |
| GET    | `/settings/webhooks/:id/deliveries`    | SI   | owner, manager | Filtros `?status=&fromDate=&toDate=&cursor=&limit=`. Lista los intentos    |

### Endpoints — Integrations (autenticadas con API key)

| Metodo | Ruta                   | Auth           | Descripcion                                                   |
| ------ | ---------------------- | -------------- | ------------------------------------------------------------- |
| GET    | `/integrations/whoami` | API key Bearer | Devuelve `{ tenantId, apiKeyId, scopes }` del key autenticado |

`/integrations/*` se autentica con `Authorization: Bearer sk_live_*`.
**No** acepta JWT.

### Formato HMAC del webhook saliente

```
POST /webhook-url HTTP/1.1
Content-Type: application/json
X-Storageos-Event: invoice.paid
X-Storageos-Delivery: 0193fa01-...-...
X-Storageos-Signature: t=1716200000,v1=2c5e9a3b...

{ "event": "invoice.paid", "data": { ... } }
```

Pseudocodigo de verificacion en el receptor:

```ts
const [tPart, sigPart] = header.split(',');
const ts = tPart.split('=')[1];
const sig = sigPart.split('=')[1];
const expected = hmacSHA256Hex(`${ts}.${rawBody}`, webhookSecret);
const ok = timingSafeEqual(sig, expected) && Math.abs(now - ts) < 300;
```

### Codigos `code` (Fase 14)

| `code`                  | Cuando                                                                     |
| ----------------------- | -------------------------------------------------------------------------- |
| `api_key_not_found`     | Lookup por id falla o key ya revocada.                                     |
| `api_key_invalid`       | `Authorization` ausente, formato distinto a `sk_live_*` o secret invalido. |
| `webhook_not_found`     | ID invalido o tenant ajeno.                                                |
| `webhook_url_invalid`   | URL no es `https://...` o resuelve a IP privada.                           |
| `webhook_event_invalid` | Algun item de `events` fuera de la whitelist.                              |

### BullMQ + colas Fase 14

| Cola       | Job       | Descripcion                                                                                  |
| ---------- | --------- | -------------------------------------------------------------------------------------------- |
| `webhooks` | `deliver` | POST HTTPS al webhook con HMAC. Retry 3× exponencial 60s. Persiste delivery con cada intento |

## Infra runtime y banderas (Fase 14)

- **`ENABLE_WORKERS_IN_API`** (env, default `true`): cuando `true`, el
  proceso de `apps/api` registra los providers de las colas BullMQ y
  procesa jobs in-process. En produccion (`.env.prod=false`) los workers
  se ejecutan en `apps/worker` separado y la API solo encola.
- **`OPENAPI_ENABLED`** (env, default no seteado): expone `/api/docs` y
  `/api/docs-json` en produccion. En dev/test siempre montado.

## Roles Postgres y RLS

La API usa dos conexiones distintas a Postgres:

- **`storageos_app`** (sometido a RLS) — para todas las queries que
  pueden usar el contexto del tenant del JWT. `PrismaService.withTenant`
  envuelve cada operacion en una transaccion que primero ejecuta
  `set_config('app.current_tenant', $1, true)`. Las politicas RLS hacen
  el filtrado automatico.

- **`storageos`** (bypass RLS por owner) — `PrismaAdminService`, usado
  para flujos sin tenant disponible: `register`, lookup de tenant por
  slug en `login`, y escritura de audit logs.

## Audit logs registrados

| Action                                                       | Cuando                                                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `auth.register`                                              | Tras crear tenant + owner.                                                                      |
| `auth.login.success`                                         | Login exitoso.                                                                                  |
| `auth.login.failed`                                          | Tenant existe pero email/password fallan. `changes.reason` ∈ `unknown_email`, `wrong_password`. |
| `auth.refresh`                                               | Refresh rotado correctamente.                                                                   |
| `auth.logout`                                                | Logout de una sesion.                                                                           |
| `auth.logout_all`                                            | Logout global; `changes.revokedCount`.                                                          |
| `user.invited`                                               | Owner/manager envia una invitacion. `entity = invitations:<id>`.                                |
| `user.invitation_revoked`                                    | Invitacion revocada manualmente.                                                                |
| `user.invitation_resent`                                     | Invitacion reenviada (la anterior queda con `revokedReason: replaced_by_resend`).               |
| `user.invitation_accepted`                                   | El destinatario acepta la invitacion; crea el user + sesion.                                    |
| `user.updated`                                               | PATCH /users/:id. `changes` contiene solo los campos modificados.                               |
| `user.deactivated`                                           | Soft delete (isActive=false) + revoca todas las sesiones del user.                              |
| `user.ownership_transferred`                                 | Transferencia atomica de owner. `changes` lleva `{ from, to }`.                                 |
| `user.password_changed`                                      | El usuario cambia su propia password desde `/me/change-password`.                               |
| `auth.2fa.enabled`                                           | El user activa 2FA tras superar `/auth/2fa/verify`.                                             |
| `auth.2fa.disabled`                                          | El user desactiva 2FA.                                                                          |
| `auth.2fa.challenge.success`                                 | Challenge superado durante el login. `changes.method` ∈ `totp`, `recovery_code`.                |
| `auth.2fa.challenge.failed`                                  | Challenge fallido durante el login (codigo erroneo).                                            |
| `auth.2fa.recovery_codes_regenerated`                        | El user regenera sus 10 recovery codes.                                                         |
| `auth.2fa.recovery_code_used`                                | Un recovery code se ha consumido (en challenge o disable).                                      |
| `facility.created/updated/deleted`                           | CRUD de facilities. `deleted` = soft delete.                                                    |
| `unit_type.created/updated/deactivated/deleted`              | CRUD de unit_types. `deactivated` cuando se borra uno con units.                                |
| `floor.created/updated/deleted/plan_uploaded/layout_updated` | Gestion de plantas y layout del plano.                                                          |
| `unit.created/updated/deleted/status_changed`                | CRUD + cambios de estado de trasteros. `status_changed.changes = { from, to, reason }`.         |
| `customer.created/updated/deleted/kyc_verified/kyc_revoked`  | CRUD customers + cambios de estado KYC.                                                         |
| `customer_document.added/deleted`                            | Subida o borrado de documentos.                                                                 |
| `contract.created/signed/ending_requested/ended/cancelled`   | Cambios de estado del contrato.                                                                 |
| `contract.price_changed`                                     | Cambio de precio. `changes.{from,to,reason}`.                                                   |
| `contract.note_added`                                        | Nota interna anyadida a la timeline.                                                            |
| `contract.pdf_generated`                                     | Generacion de PDF + URL final en MinIO.                                                         |
| `reservation.created/confirmed/cancelled/converted`          | Ciclo de vida de la reserva.                                                                    |

Los intentos de login con **tenant inexistente** no se persisten (no hay
`tenant_id` para asociarlos). Quedan en el logger y se moveran a una
tabla `security_events` global en una fase futura.

## Rate limiting

`@nestjs/throttler` con un guard global. Por defecto 60/min/IP. Los
endpoints de autenticacion lo sobreescriben con presets declarados en
`apps/api/src/common/decorators/throttle-presets.ts`:

| Endpoint                   | Limite                    |
| -------------------------- | ------------------------- |
| `POST /auth/login`         | 5 requests / minuto / IP  |
| `POST /auth/register`      | 3 requests / hora / IP    |
| `POST /auth/refresh`       | 30 requests / minuto / IP |
| `POST /auth/2fa/challenge` | 5 requests / minuto / IP  |
| `POST /auth/2fa/disable`   | 5 requests / minuto / IP  |

Cuando se supera, el guard responde `429 Too Many Requests` con
`message: "Demasiadas peticiones, prueba mas tarde."` y header
`Retry-After: <segundos>`.

En tests e2e (`NODE_ENV=test`) el throttler aplica `skipIf: () => true`.

---

## Crecimiento / CRM (2026-06)

Módulos `apps/api/src/modules/{reviews,promotions,referrals}/` + extensiones en
`facilities`. Autorización por `@RequirePermission`.

### Reviews / NPS (`/reviews`, `/public/reviews`, `/settings/tenant/reviews`)

- `POST /reviews/request` (`reviews:write`): solicita una valoración a un cliente (crea token + envía email/WhatsApp).
- `GET /reviews` (`reviews:read`), `GET /reviews/stats` (`reviews:read`): NPS = %promotores(9-10) − %detractores(0-6), media de estrellas, tasa de respuesta. Las pendientes con el enlace caducado cuentan como `expired`.
- `POST /reviews/:id/google-request` (`reviews:write`): pide al autor de una valoración publicada que la deje en Google (`googleReviewUrl` del tenant); una vez (409 `google_review_already_requested`), 400 `review_not_published` / `google_review_url_missing`.
- `PATCH /reviews/:id/web {published}` (`reviews:write`): publica o retira la valoración como testimonio de la web pública (solo respondidas con comentario; 400 `review_not_publishable`). La web solo muestra las publicadas.
- `GET /public/reviews/:token` + `POST /public/reviews/:token` (`@Public`, throttle, honeypot): contexto + envío de la valoración (NPS 0-10 + estrellas 1-5 + comentario) → emite `domain.review_submitted`.
- `GET/PATCH /settings/tenant/reviews` (`settings:read`/`settings:manage`): opt-in del cron `reviews.auto-request` (`reviews_auto_request` + `review_request_delay_days`).

### Promociones (`/promotions`)

- `GET/POST/PATCH/DELETE /promotions` (`promotions:read` / `promotions:manage`).
- `POST /promotions/validate` (`contracts:write`): previsualiza el descuento de un código sobre un precio mensual.
- Aplicación: `CreateContractSchema.promotionCode` en el alta de contrato → valida + fija `discount_amount` recurrente + `used_count++` (atómico). Solo percentage/fixed.

### Cupones (`/coupons`)

Descuento sobre el pago que se hace al contratar (no sobre las renovaciones). Importes sin IVA.

- `GET /coupons` (`promotions:read`), `POST /coupons` y `PATCH/DELETE /coupons/:id` (`promotions:manage`). 409 `coupon_code_taken`; 400 `invalid_scope` (tipo o local de otro tenant) e `invalid_coupon` (reglas sobre el resultado al editar); borrar uno usado → 409 `coupon_in_use`. El código no se edita.
- `GET /coupons/:id/redemptions` (`promotions:read`): usos (inquilino, contrato, meses, descuento).
- `POST /coupons/validate {code, unitId, months, monthlyPrice?, customerId?}` (`contracts:write`) → `CouponQuoteDto`: `{valid: true, months, rentSubtotal, discountAmount, freeMonths, rentTotal}` o `{valid: false, reason, message}` (`not_found`, `inactive`, `not_started`, `expired`, `max_uses_reached`, `invalid_months`, `min_months`, `min_amount`, `unit_type`, `facility`, `new_customers_only`).

- **Aplicación (alta de contrato)**: `POST /contracts` acepta `couponCode` y `firstPaymentMonths` (1, 3, 6 o 12). El uso se reserva al crear; la 1ª factura (al firmar) cubre esos meses con el cupón y después se factura mes a mes. Errores: 400 `coupon_<motivo>` (los de `validate`, también `coupon_already_used` con «un uso por cliente»), `coupon_with_promotion`, `coupon_with_discount` (no se suma a un descuento manual; tampoco con `PATCH /contracts/:id {discountAmount}` sobre un contrato con cupón) y `coupon_not_better`. Cancelar el contrato sin pagar libera el cupón; si el primer pago era de 0 € (cupón del 100 %) se da por usado. `ContractDto.coupon {code, months, discountAmount, freeMonths}`.

- **Resumen del primer pago** (`FirstPaymentQuoteDto`: meses, alquiler, descuento, meses gratis, IVA, seguro, fianza, total a pagar, `prorated` y el cupón con su motivo si no vale): `POST /public/move-in/book/:slug/quote {facilityId, unitTypeId, months, couponCode?}` (público, 15/min; los motivos que solo dirían si el código existe salen como «Este cupón no es válido» y no se mira si el visitante ya es cliente) y `POST /portal/me/units/:unitId/quote {months, couponCode?}` (portal). La vista de firma lo incluye en `firstPayment`.
- **Reserva online** `POST /public/move-in/book/:slug` y **portal** `POST /portal/me/contracts` aceptan `months` (1, 3, 6 o 12) y `couponCode`. Errores: 400 `coupon_not_valid` (reserva, con el motivo) y `unit_has_offer` (portal: el trastero ya tiene una oferta).
- **Reserva online con el email de un inquilino que ya existe** (sin distinguir mayúsculas): `BookingResultDto.signingToken` = `null` y `signingLinkSentTo` = el email enmascarado (`a***a@dominio`); el enlace de firma se envía por correo a ese email (fuente `booking.signing_link`). Antes se devolvía el enlace a quien rellenaba el formulario y, al firmar, recibía la sesión del área de clientes de ese inquilino (con sus códigos de acceso). Lo mismo en las reservas del asistente de WhatsApp.

### Posiciones en Google (`/seo`, extra «SEO local»)

Seguimiento con Google Search Console. La plataforma tiene una cuenta de servicio (`GSC_SERVICE_ACCOUNT_JSON`); el tenant la añade como usuario de su propiedad. Todo con `@RequireFeature('local_seo')`. En tests (o `GSC_MODE=stub`) no se llama a Google.

- `GET /seo/search-console` (`settings:read`) → `SearchConsoleSettingsDto` (`available`, `serviceAccountEmail`, `siteUrl`, `status` pending/connected/error, `lastError`, `connectedAt`, `lastSyncedAt`).
- `PUT /seo/search-console {siteUrl}` (`settings:manage`): `sc-domain:dominio` o `https://dominio/`; comprueba el acceso (400 `search_console_no_access` con el motivo; 503 `search_console_not_configured` sin cuenta de servicio) y descarga los últimos 120 días.
- `DELETE /seo/search-console` (`settings:manage`): desconecta y borra lo descargado.
- `POST /seo/search-console/sync` (`settings:manage`): descarga ya los últimos días.
- `GET /seo/positions?days=7|28|90` (`analytics:read`) → `SeoPositionsDto`: totales (clics, apariciones, posición media ponderada, % de clics) frente al periodo anterior, búsquedas con su cambio de posición, páginas (las de zona con `areaSlug`) y avisos (`page_dropped`, `page_clicks_dropped`, `query_dropped`). Cálculo en shared (`summarizeSearchConsole`).
- `GET /seo/report?month=AAAA-MM` (`analytics:read`, por defecto el mes pasado) → `SeoMonthlyReportDto`: resumen del mes frente al anterior (con `opportunities`: búsquedas entre la 4.ª y la 20.ª posición con ≥20 apariciones) y `tips` (qué mejorar: páginas que caen, oportunidades, páginas de zona sin texto, zonas buscadas sin página; `seoReportTips` en shared). 400 `invalid_month`.
- `POST /seo/report/send` (`settings:manage`): envía ya el informe del mes pasado a los propietarios.
- `PUT /seo/search-console/report {enabled}` (`settings:manage`): activa o apaga el envío mensual (activado por defecto).
- Cron `seo-report.monthly` (día 3 a las 09:00, worker): envía el informe a los tenants con Search Console, el envío activado y el extra; no repite un mes (`last_report_month`).
- Cron `search-console.daily` (worker): repasa los últimos 6 días de cada tenant conectado con el extra; guarda unos 16 meses (`search_console_rows`).

### Páginas de zona (`/settings/web/area-pages`, extra «SEO local»)

Páginas `/trasteros-en-<zona>` de la web del tenant. Una por ciudad con locales (existen siempre, con el texto generado) y, con el extra «SEO local» (`local_seo`, `addon-local-seo`, 12 €/mes), texto propio de cada ciudad y zonas cercanas sin local (máx. 10). Sin el extra el panel da 403 `feature_not_in_plan` y la web no muestra el texto propio ni las zonas cercanas. La revisión de SEO (`GET /analytics/seo-checklist`) también es de este extra. Quien tenía páginas de zona publicadas al crearse el extra lo conserva como cortesía (migración `20261106100000_local_seo_courtesy`).

- `POST /settings/web/area-pages/draft {name, facilityIds?}` (`settings:manage`) → `AreaPageDraftDto` (`kind`, `intro`, `nearestNote`, `nearbyAreas`, `faqs`, `seoTitle`, `seoDescription`): borrador con IA con los datos reales de los locales (dirección, horario, tamaños y precios con IVA) de la ciudad o, en una zona cercana, de los locales elegidos (400 `area_page_facilities_required` sin ninguno). No guarda nada. 503 `ai_not_configured` sin IA; 502 `ai_draft_failed` si la respuesta no se puede leer. Consumo en `ai_usage_events` (`area_page_draft`).
- `GET /settings/web/area-pages` (`settings:read`) → `AreaPagesSettingsDto`: `pages` (texto guardado), `overview` (cómo se ve cada página en la web: `kind` city/nearby, `redirect`, `indexable`, `introWords`, `warnings` no_intro/short_intro/no_facilities/not_published) y `singleFacility`.
- `POST` / `PATCH /:id` / `DELETE /:id` (`settings:manage`), devuelven el mismo DTO. Cuerpo: `name`, `slug?` (por defecto, del nombre), `facilityIds` (solo zonas cercanas, obligatorio en ellas), `nearestNote`, `intro`, `nearbyAreas[]` (≤15), `faqs[{question, answer}]` (≤8), `seoTitle` (≤70), `seoDescription` (≤200), `isPublished`. Si el slug coincide con la ciudad de un local es el texto de esa ciudad (los locales enviados no se guardan). Errores: 400 `area_page_facilities_required`, `invalid_facility`, `area_page_limit`; 409 `area_page_slug_taken`; 403 sin la feature.
- Reglas (`resolveAreaPages` en shared): con un solo local en la empresa, la página de su ciudad lleva (308) a la portada y la ficha del local declara la portada como canónica; con un solo local en una ciudad, la página de esa ciudad muestra la ficha completa del local con su texto (`ResolvedAreaPage.soleFacility`) y la ficha redirige (308) a ella (`PublicFacilityLandingDto.areaPage`; `AreaPageOverviewDto.soleFacilityName` en el panel); una zona cercana solo se indexa con ≥120 palabras. `PublicLandingDto.areaPages` (texto publicado) y `areaLinks` (enlaces del pie, también en la ficha); el sitemap (`citySlugs`) solo lleva las indexables y deja fuera la ficha cuando hay un solo local en la empresa o en su ciudad.

### SEO Avanzado (`/seo-advanced` y `/admin/seo`)

Un solo motor para dos ámbitos: proyectos de la plataforma (`tenant_id` nulo, panel del super admin) y el proyecto de cada tenant con el extra «SEO Avanzado» (`seo_advanced`, `addon-seo-advanced`, 199 €/mes, fuera de los planes). Quien tiene `seo_advanced` tiene también `local_seo` (`INCLUDED_FEATURES` en `effectiveFeaturesFromList`). Las rutas `/seo/...` siguen siendo las de «SEO local».

- **Tenant** (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`):
  - `GET /seo-advanced` → `SeoWorkspaceDto` (`project` o null, `available`, `serviceAccountEmail`, `limits`, `suggestedProperty`).
  - `POST /seo-advanced/project` (`name?`, `country`, `language`, `businessType`, `strategy` local/national/international, `targetLocation`, `brandTerms`): uno por tenant (409 `seo_project_exists`). Entra con la web del negocio como dominio principal (`sc-domain:<dominio propio>` o `<WEB_BASE_URL>/s/<slug>/`) y, si la cuenta de servicio tiene acceso, empieza la carga inicial. `PATCH /seo-advanced/project` (también `status` active/paused).
  - `POST /seo-advanced/domains {gscProperty, role?}`; `PATCH /seo-advanced/domains/:id {role}`; `DELETE /seo-advanced/domains/:id`; `POST …/:id/check` (comprueba el acceso; con acceso y sin carga inicial, la lanza); `POST …/:id/sync` (descarga ya; 400 `seo_domain_not_connected` / `seo_project_paused`). El principal tiene que ser una web del negocio: dominio propio verificado, dominio del correo con el TXT de propiedad verificado o su dirección en la plataforma (400 `seo_property_not_yours`; otra web como principal, también al cambiar el papel, 400 `seo_primary_not_yours`). Una propiedad de otro tenant → 409 `seo_property_taken`. **Dominio secundario externo** (§26 del plan): una web que no es «propia» entra como secundaria (`verification: 'gsc_access'` en `SeoProjectDomainDto`) si la cuenta de servicio tiene acceso a la propiedad (si no, 400 `seo_property_no_access`), no es un dominio de la plataforma ni un subdominio suyo (hosts de `WEB_BASE_URL`, `API_BASE_URL`, `MINIO_PUBLIC_URL` y el dominio de `EMAIL_FROM_ADDRESS`; 400 `seo_property_platform`) y no la usa ningún otro proyecto, de otro tenant o de la plataforma (409 `seo_property_taken`; el alta toma un candado por dominio para que dos negocios no se la queden a la vez). Se conecta y empieza su carga inicial al momento. Límites: 1 principal (409 `seo_primary_exists`) y 3 más entre secundarios y redirigidos (409 `seo_domain_limit`). Sin proyecto, 404 `seo_project_missing`.
  - `GET /seo-advanced/runs` (últimas 30), `POST /seo-advanced/runs/:id/cancel` (400 `seo_run_not_active`).
  - `GET /seo-advanced/summary?days=7|28|90&domainId=` → `SeoSummaryDto`.
  - **Panel** (`analytics:read`; parámetros comunes `period=7d|28d|90d|6m|12m|custom`, `from`/`to` con `custom` —400 `seo_invalid_range` sin ellos—, `domainId`): `GET /seo-advanced/dashboard` → `SeoDashboardDto`; `GET /seo-advanced/queries` y `GET /seo-advanced/pages` → `SeoTablePageDto` (`search`, `sort=clicks|impressions|ctr|position|change`, `dir=asc|desc`, `offset`, `limit` ≤ 200, 50 por defecto); `GET …/queries/csv` y `GET …/pages/csv` (CSV con `;`, coma decimal y BOM, hasta 10.000 filas en el orden pedido); `GET /seo-advanced/cross?dimension=query|page&value=` → `SeoCrossDto` (una búsqueda → sus páginas o una página → sus búsquedas, del cruce `query_page`, 100 filas).
  - **Importar histórico**: `GET /seo-advanced/imports` (`SeoImportDto[]`) y `GET …/imports/:id` (`SeoImportDetailDto`, con cada pestaña y sus totales recalculados) con `analytics:read`; `POST /seo-advanced/imports/preview` (200, `SeoImportPreviewDto`, no guarda nada) y `POST /seo-advanced/imports` (201) multipart con `file` (≤ 20 MB, `.xlsx` o `.zip` de CSV de Search Console, en español o en inglés) y `domainId` (400 `seo_import_domain_required`); `DELETE …/imports/:id` (204) con `settings:manage`. Errores: 400 `seo_import_file_required`, `seo_import_invalid` (con el motivo: no es una exportación, falta la pestaña Fechas, compara dos periodos…), 409 `seo_import_duplicate` (el mismo fichero —sha256— ya está en el proyecto).
- **Plataforma** (`AdminGuard`; leer cualquier super admin, cambiar el rol superadmin):
  - `GET/POST /admin/seo/projects`, `GET/PATCH/DELETE /admin/seo/projects/:id` (`GET` vale también para el proyecto de un tenant, en lectura; las escrituras a un proyecto de tenant dan 404).
  - `POST /admin/seo/projects/:id/domains`, `PATCH|DELETE …/domains/:domainId`, `POST …/domains/:domainId/check`, `POST …/domains/:domainId/sync`. La plataforma puede conectar cualquier propiedad a la que tenga acceso la cuenta de servicio.
  - `GET /admin/seo/projects/:id/runs`, `POST /admin/seo/runs/:runId/cancel`, `GET /admin/seo/projects/:id/summary?days=&domainId=`.
  - `GET /admin/seo/properties` → `SeoGscPropertiesDto` (propiedades de la cuenta de servicio y en qué proyecto están).
  - `GET /admin/seo/tenant-projects` → `SeoTenantProjectRowDto[]` (solo lectura; `featureEnabled` dice si se descarga).
  - `GET /admin/seo/overview` → `SeoProjectOverviewDto[]`: cada proyecto (plataforma y tenants) con los 28 días hasta su último dato frente a los 28 anteriores, del dominio principal.
  - Panel e importaciones de cualquier proyecto en `GET /admin/seo/projects/:id/{dashboard,queries,queries/csv,pages,pages/csv,cross,imports,imports/:importId}` (también el soporte y los de los tenants, en lectura); `POST …/imports/preview`, `POST …/imports` y `DELETE …/imports/:importId` solo el rol superadmin y solo en proyectos de la plataforma (en los de un tenant, 404), auditados `admin.seo.import_created` / `admin.seo.import_deleted`.
- **Resumen** (`SeoSummaryDto`): totales del periodo y del anterior **siempre del cruce `site`** (cuadran con Google), variación (`clicksPct`, `impressionsPct`, `ctrDiff` en puntos, `positionDiff` en puestos, positivo = mejor), reparto por dispositivo, `undetailed` (total del sitio − suma del cruce `query`: búsquedas que Google no detalla) y `delayed` (más de 4 días sin datos nuevos). Sin datos de todo el periodo anterior, `previous` y `change` van a null.
- **Panel** (`SeoDashboardDto`, `SeoPanelService`): cada parte lee de **un solo cruce** y nunca suma dos; las sumas las hace la base de datos (`SUM`/`GROUP BY`, sin traer filas) y se convierten con `seoTotalsFromSums` (lo mismo que `aggregateSearchMetrics`). Totales y evolución diaria del cruce `site` (un punto por día, los que Google no da a 0, con `source` api/import y el día equivalente del periodo anterior), dispositivos de `device`, países de `country` (los 10 primeros y el resto, `seoTopN`), tipos de búsqueda de `search_type`, búsquedas y páginas de `query` y `page`, el cruce de `query_page`. Comparaciones: periodo anterior de la misma duración y mismas fechas del año anterior (`seoPanelRange`; 6 y 12 meses por calendario), cada una solo si hay datos desde su primer día (si no, null). `otherDomains` da lo que llega por el resto de dominios del proyecto, aparte.
- **Importación** (`SeoImportsService`, `gsc-import.reader.ts` + `parseGscExport` en shared): se mira el contenido, no la extensión (los dos son zip; el `.xlsx` lleva `xl/workbook.xml`), con tope de 100 MB descomprimidos y 20 CSV. La pestaña Fechas entra en el cruce `site` (`seo_gsc_metrics.source = 'import'`, `import_id`) solo en los días que no tienen ni la API ni otra importación; si un día está en los dos, manda la API, y la descarga de la API sobrescribe lo importado de su tramo. Con filtros de país, dispositivo, búsqueda, página o un tipo que no sea la web (`analyzeGscFilters`), no entra en los totales. Las demás pestañas se guardan en `seo_gsc_import_rows` (con el CTR y la posición del Excel solo como referencia) y nunca se reparten por días. Borrar la importación borra sus filas y sus días (cascada).
- **Descarga** (cola BullMQ `seo`, job `gsc-sync`, un trabajo por ejecución `seo-gsc-<runId>`; una ejecución viva por dominio y tipo): totales (`site`, `device`, `country`, `search_type` con web/image/video/news) de una vez; `query`, `page`, `query_page`, `query_device`, `query_country` y `page_device` día a día del más reciente al más antiguo con cursor. Inicial 16 meses (`SEO_GSC_INITIAL_DAYS`), diaria los últimos 5 días (o desde el último dato) con el cron `seo.gsc-daily` (07:00 en España). Cada tramo se reescribe entero (borrar + insertar en una transacción). Solo plataforma y tenants con `seo_advanced` activos o en prueba. Al arrancar, lo pendiente vuelve a la cola.

- **SISTRIX (PR 3)**: arquitectura de proveedores (`SeoDataProvider` con capacidades: `gsc`, `sistrix_mcp`, `sistrix_api`, `manual_import`) y un enrutador por fondo y consulta: plataforma → MCP si está conectado y con cuota; si no, la API **solo** si el super admin autorizó «Continuar por API», está activada, tiene clave y le queda presupuesto semanal; si no, la tanda espera con su motivo (`mcp_quota`, `mcp_needs_reauth`, `not_connected`, `api_budget`, `daily_limit`, `not_supported`). Tenant → solo su clave de API (sin clave, solo Search Console), salvo que el super admin le active «Usar la conexión de SISTRIX de la plataforma» en su proyecto. Lo descargado se guarda en el **fondo** de la conexión con que se pidió (`tenant_id` nulo = plataforma; con valor = la clave de ese tenant): dos proyectos del mismo fondo comparten caché y datos, y lo pedido con la cuenta de la plataforma no llega a otros tenants. Cada dato lleva `provider`, `fetchedAt` y, si la hay, la fecha del dato (`SeoDataOriginDto`). Nunca se usan `project*`, `ai_tracker*` ni `ai_topicresearch` vista `list`; el país va siempre explícito.
  - Plataforma (`AdminGuard`; leer cualquier super admin, cambiar el rol superadmin): `GET /admin/seo/sistrix` → `SeoSistrixIntegrationsDto` (MCP: estado, herramientas y cambios, cuota agotada hasta…; API: clave `keyLast4`, activada, presupuesto, gastado, saldo, autorizada hasta…; frecuencias y límites; `routing`; `canContinueByApi`; tandas pendientes). `POST /admin/seo/sistrix/connect` → `{authorizationUrl}` (OAuth 2.0: descubrimiento, registro dinámico —se repite si cambia la dirección de vuelta—, PKCE y `state` firmado de un solo uso, 10 min, ligado al super admin). `GET /v1/admin/seo/sistrix/callback?code&state` (público, validado por el `state`; canjea **sin `redirect_uri`**, que SISTRIX rechaza, guarda los tokens cifrados y lee `tools/list`; redirige a `WEB_BASE_URL/admin/seo/integrations?sistrix=ok|error`). `POST …/sistrix/test` (visibilidad de trasteros.pro, sin créditos), `POST …/sistrix/tools/refresh`, `DELETE …/sistrix/connection` (revoca en SISTRIX y borra los tokens), `PUT …/sistrix/api {apiKey?, enabled?, weeklyBudget?}` (`''` borra la clave; activar sin clave 400 `sistrix_api_key_required`), `POST …/sistrix/api/test` (método `credits`, gratis), `POST|DELETE …/sistrix/api/authorize` («Continuar por API» hasta que el MCP se reanude; 400 `sistrix_api_not_ready` / `sistrix_api_budget`), `PUT …/sistrix/settings {frequencies?, maxRequestsPerDay?, maxRequestsPerBatch?, pauseMs?}`, `GET …/sistrix/requests?cursor&status&provider&projectId` (registro sin secretos), `POST …/sistrix/runs/:runId/cancel`.
  - Por proyecto (admin: cualquiera en lectura; escrituras solo en los de la plataforma, el resto 404): `GET /admin/seo/projects/:id/sistrix` → `SeoSistrixWorkspaceDto`; `PATCH …/sistrix-platform {usePlatformSistrix}` (solo superadmin y solo proyectos de tenant; 400 `seo_platform_project`); `POST …/sistrix/sync {dataType}` (`visibility`, `serp`, `domain_keywords`, `competitors`, `opportunities`, `keyword_metrics`, `backlinks`, `ai_visibility`, `keyword_ideas`; 400 `sistrix_not_configured` / `seo_project_paused`); `GET|POST …/competitors`, `PATCH|DELETE …/competitors/:id` (activos como mucho 10 en un tenant y 50 en la plataforma: 409 `seo_competitor_limit`; 400 `seo_competitor_own`; 409 `seo_competitor_exists`; los descubiertos por SISTRIX entran inactivos); `GET …/visibility` → `SeoVisibilitySeriesDto[]`; `GET …/domain-keywords?domain=` y `…/domain-keywords/history?domain&keyword` (solo dominios del proyecto o competidores: 400 `seo_domain_not_in_project`); `GET|POST …/keywords {keywords[], groupName?, priority?, source?}` (300 por tenant, 2.000 en la plataforma: 409 `seo_keyword_limit`), `PATCH|DELETE …/keywords/:id {groupName, intent, targetUrl, priority, notes, strategyLocked, isActive}`, `GET …/keywords/:id/serp`; `GET …/opportunities?kind=opportunity|idea`; `GET …/backlinks`; `GET …/ai-visibility`.
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): `GET /seo-advanced/sistrix` → `{workspace, settings: SeoTenantSistrixDto}`; `PUT /seo-advanced/sistrix/api` (su clave cifrada, nunca vuelve; presupuesto semanal propio, desactivable); `POST /seo-advanced/sistrix/api/test`; `PUT /seo-advanced/sistrix/settings` (400 `seo_using_platform` si usa la conexión de la plataforma); `POST /seo-advanced/sistrix/sync`; `POST /seo-advanced/sistrix/runs/:id/cancel`; y los mismos datos que el admin en `/seo-advanced/competitors`, `/visibility`, `/domain-keywords`, `/keywords`, `/keywords/:id/serp`, `/opportunities`, `/backlinks` y `/ai-visibility`.
  - **Tandas** (cola BullMQ `seo-sistrix`, job `sistrix-sync`, concurrencia 1 y pausa configurable entre llamadas, 1 s por defecto; una viva por proyecto y tipo de dato en `seo_sync_runs` con `data_type`, progreso por consulta y reanudación). Errores de SISTRIX que llegan como texto con `isError: false`: 1000 = vacío; 7010 = cuota del MCP agotada → se para hasta las 00:05 de Madrid (aviso al super admin) y la tanda queda «en espera». La API respeta 300 ms entre peticiones, lee los créditos de cada respuesta, consulta `credits` antes de cada tanda y corta al llegar al presupuesto (semana de lunes 00:00 de Madrid). Caché `seo_api_cache` por fondo y huella de la consulta (`sistrixQueryHash`, igual para MCP y API) con caducidad por tipo; «Sincronizar ahora» reutiliza lo de las últimas 24 h. Crons: `seo.sistrix-schedule` (cada hora: reanuda lo que esperaba y encola según la frecuencia de cada fondo), `seo.sistrix-resume` (00:05 de Madrid: vuelve la cuota y caduca la autorización de la API) y `seo.sistrix-daily` (06:30: `tools/list` y limpieza del registro, 90 días, y de la caché caducada). Si la renovación del token da `invalid_grant`: conexión «hay que volver a conectar», aviso (notificación y correo de Alertas) y tandas paradas.

- **Oportunidades (PR 4, motor propio con puntuación)**: reglas puras en shared (`detectSeoOpportunities`, `scoreSeoOpportunity`, `packages/shared/src/seo/opportunities.ts`) sobre agregaciones SQL de un dominio (`SeoOpportunityEngineService`). Tipos: `near_top3` (posición 4–10) y `near_page1` (11–20) con impresiones mínimas; `commercial_deep` (21–50 con intención comercial o de visita: la manual de tus palabras manda, luego la de SISTRIX `searchintent` y, si no, reglas sobre el texto); `low_ctr` (CTR por debajo de una parte del esperado para su posición, `expectedCtr`); `rising`/`falling` (solo con el periodo anterior comparable, `seoPeriodCovered`, y un mínimo de impresiones en los dos); `demand_gap` (§18.6: impresiones reales y volumen 0 o sin dato en SISTRIX, impresiones por encima del volumen, o volumen alto y apenas apareces); `sistrix` (`seo_domain_opportunities` que no coinciden con una propia: si coinciden, se fusionan y la propia lleva los dos orígenes); `keyword_gap` (un competidor seguido en el top 20 y tú no sales ni en Search Console —90 días— ni en SISTRIX). Las de marca (`brandTerms`, `isBrandQuery`) fuera salvo que caigan. Puntuación 0–100 con los pesos del proyecto (`seo_projects.weights`) y confianza aparte; umbrales en `seo_projects.opportunity_settings`. Se guardan en `seo_opportunities` (clave estable sha1 de tipo + dominio + búsqueda): recalcular no pisa estado, notas ni asignación; una descartada vuelve como nueva («ha vuelto», `returnedAt`) solo si sube `reappearPoints` (20) puntos. Se recalcula tras cada descarga de Search Console y tras cada tanda de SISTRIX de `opportunities`, `domain_keywords` o `keyword_metrics` (job `opportunities` en la cola `seo`, uno pendiente por proyecto, a los 60 s) y con «Recalcular ahora».
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants; cambiar: rol superadmin y solo proyectos de la plataforma, el resto 404): `GET /admin/seo/projects/:id/opportunity-engine?type=&status=&minScore=&search=&domainId=&sort=score|detected|updated&offset=&limit=` → `SeoOpportunityPageDto` (listas separadas por comas; por defecto las pendientes —nueva, vista, en curso— que siguen saliendo; hechas y descartadas solo si se piden); `GET …/summary` → `SeoOpportunitySummaryDto` (pendientes por tipo, por estado, las 5 mejores y cuántas han vuelto); `GET …/csv` (mismos filtros, hasta 5.000 filas); `GET …/settings` → `SeoOpportunitySettingsDto` (pesos, umbrales y valores por defecto); `PUT …/settings {weights?, thresholds?, reset?}` (al menos un peso positivo sin contar la dificultad: 400; recalcula); `GET …/assignees` (super admins activos o el equipo del tenant); `POST …/recalculate` → `SeoOpportunityRecalcDto {detected, created, returned, gone}`; `GET …/:opportunityId` → `SeoOpportunityDetailDto` (desglose, métricas con origen y fecha, evolución diaria de 90 días de esa búsqueda, sus páginas y resultados de Google si los hay); `PATCH …/:opportunityId {status?, dismissReason?, notes?, assignedToId?}` (descartar exige motivo: 400; asignar a quien no puede: 400 `seo_assignee_invalid`).
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): lo mismo en `/seo-advanced/opportunity-engine`, `/summary`, `/csv`, `/settings`, `/assignees`, `/recalculate` y `/:opportunityId` (asignar solo a usuarios activos de su negocio).
  - Las rutas `…/opportunities?kind=opportunity|idea` de la PR 3 siguen dando la lista en bruto de SISTRIX (en pantalla solo se usan las ideas).

- **Diagnóstico (PR 5)**: reglas puras en shared (`packages/shared/src/seo/diagnostics.ts`) sobre agregaciones SQL (`SeoDiagnosticsEngineService`, recalculado tras cada descarga en el job `opportunities`, al guardar ajustes y con «Recalcular»). Canibalización e indexación se guardan en `seo_cannibalizations` y `seo_index_findings` con el ciclo de vida de las oportunidades (estado `new`/`reviewed`/`fixed`/`ok`; recalcular no pisa estado ni notas; lo que no sale queda inactivo; lo arreglado que Google sigue enseñando después de arreglarlo vuelve como `new` con `returnedAt`).
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants; cambiar: rol superadmin y solo proyectos de la plataforma, el resto 404), bajo `/admin/seo/projects/:id/diagnostics`:
    - `GET /tracked-keywords?days=7|28|90&domainId=` → `SeoTrackedKeywordsDto`: cada palabra del proyecto con posición, variación (solo con periodo anterior completo), clics, impresiones y CTR del cruce `query`; la página que enseña Google (cruce `query_page`) frente a la URL objetivo (`targetStatus` `ok`/`other_page`/`split`/`none`/`no_target`, `suggestedUrl` = la de más clics si no hay objetivo); intención con su origen (manual > SISTRIX > reglas); volumen de SISTRIX con origen y fecha; totales por intención y por grupo; recuento por estado de la URL objetivo. Sin `domainId`, el dominio principal. `GET …/csv` (mismos parámetros). `GET …/:keywordId?days=` → `SeoTrackedKeywordDetailDto` (día a día con la página ganadora, `pageChanges`, por página, por dispositivo —`query_device`—, por país —`query_country`, 10 primeros— y la posición estimada de SISTRIX aparte, de `seo_serp_results`/`seo_domain_keywords` de tus dominios).
    - `GET /keyword-candidates?days=&domainId=&minImpressions=10&minPosition=&maxPosition=&excludeBrand=1&excludeTracked=1&search=` → `SeoKeywordCandidatesDto` (búsquedas reales del periodo, hasta 500, con marca, ya seguida e intención deducida). El alta se hace con `POST /admin/seo/projects/:id/keywords {keywords (hasta 500), groupName?, priority?, intent?, source: 'search_console'|'opportunity'|…}` (límite 2.000; tenant 300: 409 `seo_keyword_limit`).
    - `POST /keyword-import/preview {content, format: csv|xlsx}` → `SeoKeywordImportPreviewDto` (columnas palabra, grupo, intención, URL objetivo, prioridad y notas, en castellano o inglés; por fila nueva/se completa/sin cambios/fijada/error; `overLimit`) y `POST /keyword-import` → `SeoKeywordImportResultDto`: crea las nuevas (`source: import`) y en las demás solo rellena lo vacío (cada campo con la condición de seguir vacío y no estar fijada); la prioridad solo en las nuevas. 400 `seo_import_no_keyword_column`, `seo_import_unreadable`, `seo_import_too_many_rows` (5.000); 409 `seo_keyword_limit`.
    - `GET /settings` → `SeoDiagnosticSettingsDto` (umbrales de canibalización, reglas de indexación —`customIndexRules`— y valores por defecto); `PUT /settings {cannibalization?, indexRules?, reset?}` (recalcula); `POST /recalculate` → `SeoDiagnosticsRecalcDto`.
    - `GET /cannibalization?status=&severity=&kind=&search=&domainId=` → `SeoDiagnosticListDto<SeoCannibalizationDto>` (por defecto las pendientes que siguen saliendo; de más a menos grave), `GET …/summary`, `GET …/csv`, `PATCH …/:itemId {status?, notes?}`.
    - `GET /index-findings?status=&category=&search=&domainId=` → `SeoDiagnosticListDto<SeoIndexFindingDto>` (siempre `evidence: performance`, «aparece en el rendimiento de Search Console»: la indexación confirmada necesita la inspección de URL, fase 4), `GET …/summary`, `GET …/csv`, `GET …/sitemaps` → `SeoSitemapsDto` (de `listSitemaps`: enviadas, avisos, errores y si el propio mapa casa con una regla; no se descarga el XML), `PATCH …/:itemId {status?, notes?}`.
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): lo mismo en `/seo-advanced/diagnostics/…`.

- **Plan (PR 6): actuaciones y tareas SEO**. Reglas puras en shared (`packages/shared/src/seo/plan.ts`). Las actuaciones (`seo_changes`) guardan el día y la hora del cambio (hora de España), su tipo (`title_meta`, `content`, `new_page`, `internal_links`, `redirect`, `technical`, `noindex`, `target_url`, `other`) y su alcance (URLs como se apuntaron y normalizadas —`url_keys`; «/precios» sin dominio vale en cualquier dominio del proyecto— y palabras normalizadas). La comparación no se guarda: se calcula al leer desde `seo_gsc_metrics` (cruce `page` para las URLs, `query` para las palabras y `site` para el dominio entero). Ventanas de 7, 28 y 90 días: los N días antes y los N después empezando el día siguiente (el día del cambio no cuenta). Cada ventana sale con `status` `waiting` (aún no han pasado sus días más 3 de margen de Google: `daysLeft` y `availableOn`; o Google no ha dado el último día: `daysLeft: null`), `no_history` (el histórico empieza después), `incomplete` (sin datos de Google de casi todos sus días, `seoPeriodCovered` sobre el cruce `site`) o `ready`, y solo `ready` trae cifras: `scope` (las URLs si las hay; si no, las palabras; sin alcance, el sitio) con su veredicto (`better`/`worse`/`flat`/`insufficient` con menos de 50 impresiones en un lado; el texto dice «coincide con», nunca «gracias a»), `site` (el dominio entero en las mismas fechas) con `contextNote`, `items` (por URL y por palabra, solo en la ficha) y `overlaps` (otras actuaciones del mismo dominio con alcance común —o sin alcance— dentro de las dos ventanas: «resultado mezclado»). Las tareas (`seo_tasks`) tienen tipo (`content`, `technical`, `links`, `local`, `other`), estado (`todo`, `in_progress`, `review`, `done`, `cancelled`), prioridad, responsable (equipo activo del negocio o super admins activos; 400 `seo_assignee_invalid`), fecha límite y de publicación (el calendario de contenidos), URL, palabras, orden en su columna y enlaces opcionales a la oportunidad, canibalización o hallazgo que la motivó y a la actuación que se registró al cerrarla (las dos quedan enlazadas). Con `opportunityId`, `cannibalizationId` o `indexFindingId`, lo que no llegue (URLs, palabras, dominio, tipo) se rellena desde ahí; si no es del proyecto, 400 `seo_link_invalid`.
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants; cambiar: rol superadmin y solo proyectos de la plataforma, el resto 404), bajo `/admin/seo/projects/:id/plan`:
    - `GET /changes?domainId=&type=&search=&offset=&limit=` → `SeoSiteChangeListDto` (de la más reciente a la más antigua, con sus tres ventanas sin `items`); `GET /changes/csv` (mismos filtros, hasta 5.000; resultado, clics, impresiones y posición de antes y después y solapamientos de cada ventana); `GET /changes/markers?domainId=&from=&to=&query=&url=` → `SeoChartMarkerDto[]` (marcas de los gráficos; con `query` o `url`, solo las que la tocan y las de todo el sitio); `GET /changes/:changeId` → `SeoSiteChangeDetailDto` (con `items`, el día a día del alcance —90 días antes y hasta 90 después— y las marcas de las que se solapan); `POST /changes {date, time?, type, title, description?, urls?, keywords?, notes?, domainId?, opportunityId?, cannibalizationId?, indexFindingId?, taskId?}` (sin dominio, el principal; con `taskId`, la tarea queda enlazada); `PATCH /changes/:changeId` (los mismos campos); `DELETE /changes/:changeId` (204).
    - `GET /tasks?status=&type=&assignedTo=<id>|none|me&from=&to=&search=` → `SeoTaskListDto` (hasta 500, por estado y orden; `from`/`to` filtran por fecha límite o, si no hay, de publicación; `today` en hora de España; `truncated`); `GET /tasks/csv`; `GET /tasks/:taskId`; `POST /tasks {title, description?, type?, status?, priority?, assignedToId?, dueDate?, publishDate?, domainId?, url?, keywords?, opportunityId?, cannibalizationId?, indexFindingId?, changeId?}` (al final de su columna); `PATCH /tasks/:taskId` (cambiar de estado la pone al final de la columna nueva; `done` fija `completedAt`); `POST /tasks/:taskId/move {status, index}` (200; reordena la columna de destino); `DELETE /tasks/:taskId` (204).
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): lo mismo en `/seo-advanced/plan/…` (`assignedTo=me` = el usuario).
  - Avisos (uno por tarea, persona y día, reservado en la propia tarea): al asignar una tarea a otra persona (tenant: notificación del panel `seo.task_assigned` para esa persona; plataforma: aviso del super admin con `recipientId`) y, cada mañana (cron `seo.tasks-due`, 08:00 de Madrid, en el worker), de las abiertas que vencen hoy o van atrasadas (`seo.task_due`; sin responsable, a quien tiene `settings:manage` o a los super admins).

- **Excel maestros de SEO (PR 7)**. Reglas puras en shared (`packages/shared/src/seo/master-import.ts`: `parseSeoMaster`, mapeos y DTO). Un maestro (`.xlsx`, ≤ 20 MB; también los que genera el OpenXML SDK, con el prefijo `x:` y destinos absolutos: el lector de Excel del importador los normaliza) trae las hojas `Resumen`, `Maestro_keywords`, `Rankings_competencia`, `Competidores`, `Clusters`, `Plan_accion`, `GSC_*` y `Fuentes_importacion`. El `Dominio` del Resumen tiene que ser un dominio del proyecto (400 `seo_master_domain_mismatch`, con los dominios del proyecto en el mensaje). Cada hoja va a su sitio con las reglas del propio maestro: clave `keyword_id` (`dominio|palabra`) en minúsculas y con tildes; celda vacía = no consultado y cero = valor; el CTR y la posición de un día sin impresiones se ignoran; nada pisa lo decidido a mano ni el histórico.
  - `Maestro_keywords` → `seo_project_keywords` (`source: master`, `master_import_id`): las nuevas con grupo, intención (Transaccional/Comercial → `do`, Informativa → `know`, Navegacional → `website`; Mixta y Excluir, sin intención), prioridad (Muy alta/Alta → 1, Media → 2, Baja → 3), URL objetivo y notas («Del maestro: acción · estado · relevancia N/4»); las marcadas «Descartar» entran sin seguir (`isActive: false`). En las que ya hay solo se rellena lo vacío (grupo, intención, URL y notas; la prioridad solo en las nuevas) y las fijadas (`strategy_locked`) no se tocan. Límite del catálogo (300 tenant, 2.000 plataforma): lo que no cabe se omite con el motivo. Las métricas de SISTRIX van a `seo_keyword_metrics` como observación (`provider: manual_import`, fecha = `fecha_consulta`, país), sin repetir la misma fecha; la posición propia de SISTRIX, a `seo_domain_keywords` del dominio.
  - `Rankings_competencia` → `seo_domain_keywords` (`manual_import`, `sample_date` = fecha de consulta; la misma palabra y dominio repetidos: la mejor posición); `Competidores` → `seo_competitors` (`source: master`, estrategia en notas; los que pasan del límite —10 en un tenant—, inactivos como sugerencia; el propio dominio, omitido); `Clusters` → `seo_keyword_groups` (prioridad, URL objetivo principal y nota; en los que ya hay, solo lo vacío); `Plan_accion` → `seo_tasks` (`external_ref` = P01…, no se duplica ni se pisa al reimportar; plazo «Semana N» = día de importación + 7·N, «Mes N» = + N meses; ruta → URL del dominio; título, detalle y KPI en la descripción; estado mapeado; tipo por la acción; prioridad por la de su grupo); `GSC_*` → una importación de Search Console de la PR 2 ligada (`seo_gsc_imports.master_import_id`; solo entran los días que no tienen la API ni otra importación; las palabras de `Maestro_keywords` con datos del mismo periodo que no estén en `GSC_consultas` se añaden a las consultas); `Resumen` y `Fuentes_importacion` se guardan con la importación.
  - Tenant (`@RequireFeature('seo_advanced')`): `GET /seo-advanced/master-imports` (`SeoMasterImportDto[]`), `GET …/master-imports/:id` (`SeoMasterImportDetailDto`: lo que hizo cada hoja, Resumen, reglas, filas con aviso y grupos) y `GET /seo-advanced/keyword-groups` (`SeoKeywordGroupDto[]`) con `analytics:read`; `POST /seo-advanced/master-imports/preview` (200, `SeoMasterPreviewDto`: por hoja nuevas, rellenadas, que ya estaban y omitidas con el motivo, y las notas; no guarda nada) y `POST /seo-advanced/master-imports` (201) multipart con `file`; `DELETE …/master-imports/:id` (200, `SeoMasterRemoveResultDto {removed, kept, reverted}`: se van sus observaciones y su Search Console; lo que creó, si nadie lo ha cambiado después; lo que rellenó vuelve a vacío si sigue igual) con `settings:manage`. Errores: 400 `seo_master_file_required`, `seo_master_invalid` (con el motivo), `seo_import_too_large`, `seo_master_domain_mismatch`; 409 `seo_master_duplicate` (el mismo fichero —sha256— ya está en el proyecto).
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants): lo mismo bajo `/admin/seo/projects/:id/{master-imports,master-imports/:importId,keyword-groups}`; importar y borrar solo el rol superadmin y solo en proyectos de la plataforma (en los de un tenant, 404), auditados `admin.seo.master_import_created` / `admin.seo.master_import_deleted`.
  - Origen: `SeoProjectKeywordDto`, `SeoTrackedKeywordDto` y `SeoCompetitorDto` ganan `masterImportedAt`; la tarea lleva `sourceLabel` «Importado del maestro, dd/mm/aaaa (P01)»; `SeoImportDto` gana `masterImportId` y `DELETE /…/imports/:id` de una importación de Search Console que viene de un maestro da 409 `seo_import_from_master`.
- **Lo que trae Google, alertas e informes (PR 8)**. Reglas puras en shared (`packages/shared/src/seo/conversions.ts`, `alerts.ts` y `reports.ts`).
  - **Conversiones orgánicas**: cuentan las que llegan con origen Google sin anuncios (`isOrganicGoogleSource`: `utm_source=google` con `utm_medium=organic` o sin medio). En un negocio: reservas online (`booking_started`, con su origen `metadata.bookingUtm` o el del contacto), firmadas (`booking_signed`), pagadas (`booking_paid`, ingresos = lo cobrado de la primera factura, sin la fianza), contactos de la web (`contact`, sin los creados por la reserva ni a mano) y lista de espera (`waitlist`). En la plataforma (proyecto marcado o con el dominio de `WEB_BASE_URL`): formulario de trasteros.pro (`demo_request`, contacto, demo y calculadora), altas (`signup`) y altas que pagan (`paid_signup`, primer pago de la suscripción). Por día (hora de España), tipo y página de entrada (`seoLandingKey`: la ruta en minúsculas, sin parámetros, barra final ni `/s/<negocio>`) en `seo_conversions_daily`. Los recuentos van hasta hoy (hora de España) en todos los periodos y se comparan con los mismos días justo antes; la tasa = principales (`SEO_PRIMARY_CONVERSION_TYPES`) ÷ clics del cruce `site` de todos los dominios del proyecto, solo con los días que ya ha dado Google (`seoConversionRanges`: `rateFrom`–`rateTo`, los mismos para el numerador y el denominador, y su comparación con los mismos días justo antes) y con esos días completos (`seoPeriodCovered`). Las páginas de entrada: conversiones hasta hoy; clics y tasa, con los días de Google. Por búsqueda, estimación (`estimateSeoConversionsByQuery`: cada página se reparte entre las búsquedas que llevan a ella según sus clics del cruce `query_page`).
  - **Página de entrada**: `landingPath` (opcional, ≤ 300) en `utmFields` (reserva online, contacto de la web, chat, captura de la reserva), en el alta pública de la lista de espera (`PublicJoinWaitlistSchema`, con sus `utm*`), en el formulario de trasteros.pro (`SubmitPlatformContactSchema`) y en el registro (`RegisterSchema`). Se guarda en `leads.landing_path` (y en `metadata.bookingUtm.landing`), `waitlist_entries`, `platform_contact_messages` (con `kind`) y `tenants.signup_*`.
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): `GET /seo-advanced/conversions?period=&from=&to=` (`SeoConversionsDto`: por tipo con el periodo anterior si es comparable, principales con clics y tasa, ingresos, páginas de entrada con clics, conversiones y tasa, y búsquedas estimadas) y `POST /seo-advanced/conversions/recalc` (200, últimos 90 días). `GET /seo-advanced/alerts?status=live|open|silenced|resolved&type=` (`SeoProjectAlertListDto`, con `openCount`, `silencedCount`, `checkedAt` y los ajustes), `POST …/alerts/check` (200 `{created, reopened, resolved, open}`), `PUT …/alerts/settings` (`UpdateSeoAlertSettingsSchema`: umbrales, reglas apagadas, `email`, `reset`), `POST …/alerts/:alertId/silence {days?}`, `…/unsilence` y `…/resolve` (200). `GET /seo-advanced/reports` (`SeoReportsDto`: ajustes, historial y quién puede recibirlos), `GET …/reports/preview?kind=weekly|monthly` (`SeoReportContentDto`, el último periodo cerrado sin enviarlo), `PUT …/reports/settings` (`weekly`, `monthly`, `recipientIds` de quien tiene `settings:manage`: otro → 400 `seo_report_recipient_invalid`), `POST …/reports/send {kind}` (200, solo a quien lo pide; basta `analytics:read`) y `GET …/reports/:reportId/pdf` (`{url}` firmada 5 min).
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants): lo mismo bajo `/admin/seo/projects/:id/{conversions,alerts,reports}`; recalcular, comprobar, cambiar ajustes, silenciar, resolver y enviar solo el rol superadmin y en proyectos de la plataforma (en los de un tenant, 404). Además `PUT /admin/seo/projects/:id/conversions/settings {platformConversions: true|false|null}` (si el proyecto cuenta lo de trasteros.pro; null = por el dominio; auditado `admin.seo.conversion_settings_changed`) y `extraEmails` en los ajustes del informe (correos de fuera, solo en la plataforma).
  - **Alertas**: `clicks_drop` (7 días hasta el último dato frente a los 7 anteriores, con las dos semanas completas), `position_drop` (palabras seguidas de prioridad alta), `gsc_stale` / `gsc_access_lost` (`seo_project_domains`), `private_page` (indexación nueva de categoría acceso, privada o pruebas), `cannibalization` (nueva de gravedad alta), `sistrix_reconnect` / `sistrix_quota` (la conexión de SISTRIX del proyecto; ya las avisa la PR 3: solo entran en la lista). Una viva por clave (índice parcial `seo_alerts_live_key`), se resuelven solas (`resolvedBy: auto`) y silenciadas vuelven al acabar el plazo si siguen pasando. Aviso de las nuevas: tenant, notificación `seo.alert` a quien tiene `settings:manage` (y correo si `email`); plataforma, aviso del super admin y Telegram/Slack (`ChatAlertsService`, evento `seo.platform_alert`).
  - **Informes**: semanal (semana de lunes a domingo anterior) y mensual (mes anterior), con el periodo anterior del mismo tamaño. Se reservan por proyecto y periodo (`seo_reports_cron_key`): repetir el cron no envía dos veces. El PDF va al bucket privado `reports` (`<tenant|platform>/seo-reports/<proyecto>/<informe>.pdf`) y el correo lleva un enlace firmado de 7 días (el envío de correo no admite adjuntos).

- **Inspección de URL y PageSpeed (PR 9)**. Reglas puras en shared (`packages/shared/src/seo/inspection.ts`).
  - **Inspección de URL** (`SearchConsoleClient.inspectUrl`): `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect` `{inspectionUrl, siteUrl, languageCode: 'es-ES'}` con la cuenta de servicio y el ámbito de solo lectura (`webmasters.readonly`, que la documentación admite; no hace falta el de escritura). Se guarda veredicto, `coverageState`, `robotsTxtState`, `indexingState`, `pageFetchState`, último rastreo, `crawledAs`, canónicas de Google y declarada, sitemaps, referentes, usabilidad móvil y resultados enriquecidos. Indexada = `PASS`; `NEUTRAL`/`FAIL` = no; sin veredicto = no se sabe. **Canónica distinta**: la de Google no es la declarada (o, sin declarada, no es la propia URL; normalizadas). La URL tiene que ser de un dominio del proyecto (una ruta `/precios` va al principal; en una propiedad de prefijo se reescribe con su protocolo y su `www`): si no, 400 `url_not_in_project`.
  - **Cuota**: Google deja 2.000 al día y 600 al minuto por propiedad; el día se cuenta en la **hora del Pacífico** (Google no dice cuándo se reinicia; es como reinician las cuotas diarias de sus APIs). Tope propio por proyecto (200 en un tenant, 1.000 en la plataforma; editable). Cada consulta se reserva con un candado por propiedad (`quota_day`); sin cuota (o con un 429 de Google, que no cuenta) la petición queda en cola hasta que se reinicia (`scheduled_for`) y se avisa una vez al día (`seo.inspection_quota`). La cola va con pausa de 1 s entre llamadas.
  - **Lote programado** (opcional, apagado por defecto): las URL objetivo de las palabras de prioridad alta, los hallazgos de indexación abiertos y las páginas con más clics de 28 días, sin repetir antes de `inspectionReinspectDays` (14) y sin pasar de `inspectionBatchMax` ni de la cuota (`selectSeoInspectionBatch`). Cron `seo.inspection-batch` (06:30) y `seo.inspection-queue` (cada hora, lo que esperaba a la cuota), en el worker; job `url-inspections` de la cola `seo`.
  - **Integración**: `SeoIndexFindingDto.inspection` (lo que dice Google de la URL: «Indexación confirmada (fecha)» o «Google dice que no está indexada (motivo)») y `evidence: 'performance' | 'inspection'`; categorías nuevas de indexación `canonical_mismatch` y `not_indexed` (URL objetivo de una palabra seguida activa que Google no tiene), que mantiene la inspección con el mismo ciclo de vida (el recálculo del diagnóstico ya no las apaga). `SeoTrackedKeywordDto.targetIndex`, `SeoOpportunityDetailDto.urlIndex` y `pages[].index`. Alertas nuevas `target_not_indexed` (alta si la palabra es de prioridad alta), `canonical_mismatch`, `pagespeed_slow` y `pagespeed_drop` (umbral `pagespeedDropPoints`, 15). En los informes, `technical` (inspeccionadas, indexadas, no indexadas, canónica distinta, páginas medidas y lentas).
  - **PageSpeed Insights** (`PageSpeedClient`): `GET https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=&strategy=mobile|desktop&category=performance&category=seo&category=accessibility&category=best-practices&locale=es[&key=]` con `PAGESPEED_API_KEY` opcional, un minuto por intento y tres intentos ante 429, 5xx o tiempo agotado. Se guarda por URL y estrategia (`seo_pagespeed_runs`, histórico): puntuaciones 0-100, laboratorio (LCP, CLS, TBT, FCP, Speed Index, TTI), campo de Chrome (LCP, INP y CLS con su categoría FAST/AVERAGE/SLOW, de la URL o, si no hay, del origen) y las 8 mejoras de más ahorro. Bajo demanda (cola `seo`, job `pagespeed`) y cada lunes (`seo.pagespeed-weekly`, 04:30): la portada, las URL objetivo de prioridad alta y las páginas con más clics, hasta `pagespeedMaxUrls` (10 tenant, 20 plataforma) × 2 estrategias.
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, inspeccionar, medir y cambiar `settings:manage`): `GET /seo-advanced/inspections` (`SeoInspectionsDto`: cuota del día —`used`, `cap`, `remaining`, `resetsAt`, `queued`, `waitingNextDay`—, ajustes, la última de cada URL y resumen), `GET …/inspections/history?url=` (`SeoInspectionHistoryDto`), `POST …/inspections {url}` (200 `SeoInspectResultDto`: la inspección, `deferred` y un mensaje; si ya espera, la misma), `POST …/inspections/batch` (200 `{queued}`, el lote ahora aunque esté apagado), `PUT …/technical/settings` (`UpdateSeoTechnicalSettingsSchema`: `inspectionDailyCap`, `inspectionBatchEnabled`, `inspectionReinspectDays`, `inspectionBatchMax`, `pagespeedEnabled`, `pagespeedMaxUrls`, `reset`), `GET …/pagespeed` (`SeoPageSpeedDto`: la última de cada URL por estrategia, pendientes, `keyConfigured`), `GET …/pagespeed/history?url=&strategy=` (`SeoPageSpeedHistoryDto`) y `POST …/pagespeed {url, strategies?}` (200, las mediciones en cola).
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants): lo mismo bajo `/admin/seo/projects/:id/{inspections,inspections/history,inspections/batch,technical/settings,pagespeed,pagespeed/history}`; inspeccionar, medir, lanzar el lote y cambiar ajustes solo el rol superadmin y en proyectos de la plataforma (en los de un tenant, 404); los ajustes, auditados `admin.seo.technical_settings_changed`.

- **Rastreador de las webs (PR 10)**. Reglas puras en shared (`packages/shared/src/seo/crawler.ts`); el API en `apps/api/src/modules/seo-advanced/crawler/`.
  - **Qué pide**: peticiones GET sin navegador sin cabeza, con el agente de usuario `TrasterOS-SEO-Crawler/1.0 (+https://trasteros.pro/rastreador)` (token de robots.txt `trasteros-seo-crawler`). Empieza por la portada del dominio principal (o por la ruta de su propiedad de Search Console si es de prefijo: `https://trasteros.pro/s/negocio/` solo rastrea lo que cuelga de ahí), sigue los enlaces internos en anchura y después pide las URL de los mapas del sitio, las páginas con impresiones de Search Console (90 días) y las de los hallazgos de indexación abiertos (estas, aunque sean de otro dominio del proyecto, solo para confirmar su motivo; no se siguen sus enlaces).
  - **robots.txt**: se lee al empezar (4xx = sin reglas; 5xx o sin respuesta = el rastreo falla, como hace Google). Grupo más específico para el token del rastreador (si no, `*`), la regla más larga gana y a igual largo gana `Allow`; comodines `*` y `$`. Lo bloqueado no se pide (queda la fila con `robotsBlocked` y la regla); también se calcula si Google (`googlebot`) puede leer cada URL. Mapas del sitio: los de `Sitemap:` (solo de los dominios del proyecto) o `/sitemap.xml`; índices hasta 20 ficheros; `.gz` no se leen.
  - **Seguridad (SSRF)**: `SeoCrawlFetcher` solo pide hosts de los dominios del proyecto (con y sin `www.`), valida la forma de la URL (`checkOutboundUrlShape`: http/https, sin credenciales, sin IP privadas literales ni nombres internos) y la IP en el momento de conectar en cada salto (ninguna privada, de loopback, link-local o de metadatos), sigue las redirecciones a mano (5 como mucho; una a otro dominio se anota sin seguirla), corta la descarga a los 3 MB y la petición a los 15 s, y solo lee el cuerpo de HTML, XML y texto (solo se analiza `text/html`). En pruebas, `useTestRouting` lleva todo a un servidor local (lo único que permite 127.0.0.1; fuera de `NODE_ENV=test` lanza un error) y sin él no sale nada a la red.
  - **Límites**: páginas por rastreo (`maxPages`: 500 tenant, 2.000 plataforma), pausa entre peticiones (`pauseMs`, 1 s), tiempo máximo (`maxMinutes`: 60 tenant, 240 plataforma), una petición a la vez por rastreo y dos rastreos a la vez como mucho (cola `seo-crawl`, concurrencia 2). Rutas excluidas con la sintaxis de las reglas de indexación (`/ruta`, `?param`, `*texto*`).
  - **Ejecución**: `seo_crawls` (uno vivo por proyecto, índice parcial `seo_crawls_live_key`), `seo_crawl_pages` (cada URL de cada rastreo con su código, redirecciones, tiempo, título, descripción, H1, canónica, robots, hreflang, tipos JSON-LD, imágenes sin alt, enlaces internos y sus claves, profundidad y enlaces que llegan; se conservan los 10 últimos rastreos por proyecto) y `seo_crawl_issues`. Cancelable (para tras la página en curso) y reanudable: al arrancar el proceso, lo que quedó en cola o «en curso» sin señal (3 min) vuelve a la cola y sigue sin volver a pedir lo guardado. Rastreo semanal (cron `seo.crawl-weekly`, cada hora en el minuto 5 en el worker): el día y la hora de los ajustes (España), apagado por defecto en los tenants y encendido en la plataforma (lunes 03:00), sin repetir en 6 días.
  - **Incidencias** (una por tipo y URL; gravedad alta, media o baja; cada tipo con «qué pasa» y «qué hacer» en `SEO_CRAWL_ISSUES`): página que da error, no se pudo leer, respuesta lenta (>3 s), cadena de redirecciones, enlaces internos rotos y a una página que redirige, bloqueada por robots.txt, título y meta descripción (falta, repetido, largo, corto), H1 (falta, varios, repetido), canónica (falta, a otra página, la misma escrita de otra forma, que redirige, que da error), «noindex», «nofollow», idiomas mal puestos, JSON-LD que no se lee, imágenes sin alt, huérfana (en el mapa del sitio o con impresiones y sin enlaces que lleguen), a 4 clics o más de la portada, con impresiones y sin rastrear, sin mapa del sitio, mapa que no se lee, y en el mapa del sitio con error, redirección, «noindex» o bloqueo. La portada y las URL objetivo suben a gravedad alta. **Ciclo de vida** como el de los hallazgos de la PR 5: volver a rastrear no pisa estado ni notas; lo que ya no sale se resuelve solo (`active=false`, `fixed`) y vuelve como nueva si reaparece (`returnedAt`); comparación con el rastreo anterior en `summary` (nuevas, resueltas, siguen).
  - **Integración**: `SeoIndexFindingDto.crawl` (lo que confirma el rastreador: privada sin «noindex» ni bloqueo, variante sin canónica a la buena, dominio que debería redirigir y responde 200, o que ya está arreglado). Enlazado interno de las URL objetivo (enlaces que llegan, desde dónde y páginas sugeridas: las que tienen impresiones por búsquedas relacionadas en el cruce `query_page` de 28 días y aún no la enlazan). Oportunidad nueva `internal_links` («URL objetivo con pocos enlaces internos», umbral `internalLinksMin` = 3 en los ajustes de oportunidades) con la misma puntuación de siempre (los datos de Google de la búsqueda si los hay). Alertas `crawl_errors` (páginas que dan error nuevas en el último rastreo; clave por rastreo) y `crawl_critical` (portada o URL objetivo con «noindex», bloqueada para Google o que no responde; alta). En los informes, `crawl` (el último rastreo: páginas, incidencias por gravedad, nuevas, resueltas y errores).
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, rastrear, cancelar, cambiar ajustes y el estado de las incidencias `settings:manage`): `GET /seo-advanced/crawl` (`SeoCrawlOverviewDto`: ajustes, el vivo, el último terminado, los 10 últimos, abiertas por gravedad y tipo, agente de usuario), `POST /seo-advanced/crawl` (200 `SeoCrawlStartResultDto`; si ya hay uno vivo, ese con `alreadyRunning: true`), `POST …/crawl/:crawlId/cancel` (204), `PUT …/crawl/settings` (`UpdateSeoCrawlSettingsSchema`: `weeklyEnabled`, `weekday` 0-6, `hour`, `maxPages`, `pauseMs`, `maxMinutes`, `excludePaths`, `reset`), `GET …/crawl/issues?severity=&type=&group=&view=open|resolved|all&status=&onlyNew=&search=` (`SeoCrawlIssueListDto`, 500 como mucho; filtro no válido → 400 `invalid_filter`), `GET …/crawl/issues/csv`, `PATCH …/crawl/issues/:issueId {status?, notes?}`, `GET …/crawl/pages?filter=all|issues|errors|redirects|noindex|blocked|orphans&search=` (`SeoCrawlPageListDto`, del último rastreo), `GET …/crawl/page?url=` (`SeoCrawlPageDetailDto`: datos, enlaces que entran y salen, incidencias y lo que dice Google; 404 `seo_crawl_page_missing`) y `GET …/crawl/internal-links` (`SeoCrawlInternalLinksDto`).
  - Admin (`AdminGuard`; leer cualquier super admin, también los proyectos de los tenants): lo mismo bajo `/admin/seo/projects/:id/crawl…`; rastrear, cancelar, cambiar ajustes y el estado de las incidencias solo el rol superadmin y en proyectos de la plataforma (en los de un tenant, 404); los ajustes, auditados `admin.seo.crawl_settings_changed`.

- **Asistente de SEO y borradores de contenido (PR 11)**. Lo puro en shared (`packages/shared/src/seo/assistant.ts`); el API en `apps/api/src/modules/seo-advanced/assistant/`.
  - **Cómo funciona**: un chat por proyecto que usa el mismo bucle con el modelo, la cuota y el registro del consumo que el asistente del panel (`AiService.runToolLoop`; sin SDK nuevo). Herramientas de **solo lectura** que llaman a los mismos servicios que las pantallas, con el mismo dueño (un tenant solo su proyecto; el super admin, cualquiera): `seo_summary` (periodo frente al anterior y al del año anterior), `seo_changes` (búsquedas o páginas que más suben o bajan), `seo_keyword` (ficha de una palabra), `seo_opportunities` (con su desglose), `seo_diagnostics` (canibalización o indexación), `seo_technical` (inspecciones o PageSpeed), `seo_crawl`, `seo_competitors`, `seo_serp`, `seo_conversions` y `seo_plan` (actuaciones con su antes y después y tareas). Cada resultado lleva su origen y su fecha; si no hay dato, lo dice.
  - **Seguridad**: el texto que viene de fuera (búsquedas de la gente, dominios, títulos y URL de la competencia, textos de páginas rastreadas, mensajes de Google) va entre `⟦externo⟧` y `⟦/externo⟧` (`seoUntrusted`: sin caracteres de control ni invisibles, sin poder cerrar el bloque desde dentro, recortado) y el prompt de sistema dice que es un dato y nunca una instrucción. Ninguna herramienta escribe: las `seo_propose_*` (tarea SEO, actuación, oportunidad en curso, seguir una palabra) solo dejan una acción `proposed` en `seo_ai_actions`, se ofrecen únicamente a quien puede cambiar el proyecto y se ejecutan al confirmarlas, con los servicios de siempre (una sola vez: reserva atómica; caducan a los 7 días).
  - **Cuota y coste**: incluido en SEO Avanzado (no exige `ai_assistant`) y cuenta contra el límite mensual de IA del tenant (`AiQuotaService.reserve`; al gastarlo, 429 `ai_monthly_limit_reached`, o sigue con su clave propia). El consumo va a `ai_usage_events` con `feature = 'seo_assistant'` (preguntas y briefs) y se ve aparte en «Uso por tenant» (`ai.seoAssistantCalls`, `ai.seoAssistantCostUsd`). En el panel admin, con la clave de la plataforma y sin límite, registrado en `platform_ai_usage_events` (en `GET /admin/ai-settings/usage`: `platformOwn`, ya sumado en el gasto).
  - **Briefs**: desde una palabra seguida, una oportunidad, un grupo o una URL del proyecto (otra web → 400 `seo_url_outside_project`). Reúne las búsquedas de Search Console de 90 días (de la página objetivo en el cruce búsqueda + página o, si no hay, de las palabras), lo ya descargado de SISTRIX (preguntas `questions`, ideas y primeros resultados de Google de `seo_serp_results`: solo dominio y URL; nunca se lanza una consulta de pago ni se descarga el contenido de la competencia), el enlazado interno del último rastreo (páginas desde las que enlazar y URL objetivo a las que enlazar), lo que tiene hoy la página (título, descripción y H1 del rastreo) y, en un tenant, los datos públicos del negocio (locales, horarios, tamaños y precios, marcados para verificar). El modelo devuelve la intención, el objetivo, el H1, la estructura, preguntas frecuentes y 3 propuestas de título y descripción; las longitudes las calcula el servidor (`seoMetaProposal`: título 30-60, descripción 70-160). Se guarda en `seo_content_briefs` con su Markdown (`seoBriefMarkdown`, con el aviso de IA) y lo que falta en `dataNotes`. Respuesta que no se puede leer: 502 `seo_brief_unreadable` (la consulta no cuenta).
  - Tenant (`@RequireFeature('seo_advanced')`): preguntar y ver sus conversaciones con `ai:use` + `analytics:read`; confirmar acciones con `ai:use` + `settings:manage`. `GET /seo-advanced/assistant/conversations`, `GET|DELETE …/conversations/:conversationId`, `POST …/assistant/chat` (200 `SeoAssistantChatResultDto`), `POST …/assistant/chat/stream` (Server-Sent Events como `/ai/chat/stream`: `start`, `text`, `tool`, `done`, `error`; la consulta se reserva antes de abrir el stream), `POST …/assistant/actions/:actionId/confirm` y `…/discard` (200 `SeoAssistantActionDto`; `resultLink` = pestaña del proyecto: `plan`, `oportunidades` o `palabras`). Briefs: `GET /seo-advanced/briefs` y `GET …/:briefId` (`analytics:read`), `GET …/:briefId/markdown` (`text/markdown`), `POST /seo-advanced/briefs` (`ai:use` + `analytics:read`; cuerpo `{source:'keyword', keywordId}` · `{source:'opportunity', opportunityId}` · `{source:'group', groupName}` · `{source:'url', url}`; 201 `SeoBriefDto`), `PATCH …/:briefId {title?, status?: draft|in_progress|published, contentMarkdown?}`, `DELETE …/:briefId` (204) y `POST …/:briefId/draft {blog?, task?}` (`settings:manage`; 200 `SeoBriefToDraftResultDto`): una entrada **en borrador** del blog del tenant (solo con Web Premium: si no, 403 `seo_brief_blog_unavailable`) con el esquema y el aviso de IA, y/o una tarea SEO de contenido enlazada; repetida, 409 `seo_brief_draft_exists`/`seo_brief_task_exists`. Nunca se publica nada.
  - Admin (`AdminGuard`): lo mismo bajo `/admin/seo/projects/:id/assistant…` y `/admin/seo/projects/:id/briefs…`. Preguntar y leer: cualquier super admin, en cualquier proyecto (en los de un tenant no se ofrecen las herramientas de acciones). Confirmar acciones, generar, cambiar, borrar y pasar a borrador (blog de la plataforma): el rol superadmin y solo en proyectos de la plataforma (en los de un tenant, 404; el rol soporte, 403).

- **Google Analytics del tráfico orgánico (PR 12)**. Lo puro en shared (`packages/shared/src/seo/ga4.ts`); el API en `apps/api/src/modules/seo-advanced/ga4/`.
  - **Qué descarga**: con la misma cuenta de servicio y el mismo `Ga4Client` que Marketing (Data API v1beta, `runReport` paginado), solo el tráfico orgánico de Google (`dimensionFilter`: `sessionDefaultChannelGroup = Organic Search` y `sessionSource = google`) por `date`, `hostName` y `landingPagePlusQueryString`, con `sessions`, `totalUsers`, `engagedSessions`, `averageSessionDuration`, `screenPageViews` y `keyEvents`. La página se normaliza con `seoLandingKey` (la clave de las conversiones de la PR 8: sin parámetros, sin barra final ni `/s/<negocio>`) y las variantes del mismo día se suman; la duración se guarda como total para poder sumar. Tabla `seo_ga4_landing_daily` (una fila por proyecto, día, host y página). Carga inicial de 16 meses por tramos de un mes y descarga diaria de los últimos días (`seo.ga4-daily`, 07:20 en el worker; job `ga4-sync` de la cola `seo`): cada tramo sustituye lo guardado en sus fechas, repetir no duplica. Simulado con `NODE_ENV=test`/`GSC_MODE=stub` (la propiedad `403403403` no da acceso).
  - **Propiedad**: la del proyecto (`{source:'own', propertyId}`, número de la propiedad, admite `properties/123`) o, en un tenant, la que ya conectó en Marketing (`{source:'marketing'}`; 400 `seo_ga4_marketing_missing` si no la tiene o no está comprobada): no se piden credenciales ni se repite la comprobación. Sin acceso de la cuenta de servicio, 400 `seo_ga4_no_access` (con el correo y los pasos); una propiedad de otro dueño (otro negocio, en Marketing o en SEO, o la plataforma), 409 `seo_ga4_property_taken`; en un tenant, una propia tiene que medir su web (la misma comprobación que Marketing: 400 `ga4_measurement_id_required`, `ga4_measurement_id_shared`, `ga4_property_mismatch` o `ga4_property_unverified`). Si la de Marketing se quita o cambia, la siguiente descarga deja el proyecto en error con el motivo.
  - Tenant (`@RequireFeature('seo_advanced')`; leer `analytics:read`, cambiar `settings:manage`): `GET /seo-advanced/ga4` (`SeoGa4SettingsDto`: propiedad, origen, estado, fechas de los datos y `marketing` con la conexión de Marketing), `PUT /seo-advanced/ga4` (conectar; descarga los 16 meses en la cola), `DELETE /seo-advanced/ga4` (quita la conexión y lo descargado), `POST /seo-advanced/ga4/sync` (200), `GET /seo-advanced/ga4/pages?period=&from=&to=&domainId=&sort=clicks|impressions|sessions|engagement|conversions` (`SeoGa4PagesDto`: por página de entrada, Search Console —clics, impresiones, CTR y posición del cruce `page`—, GA4 —sesiones, usuarios sumados por día, interacción, duración media, páginas por sesión y eventos clave— y las conversiones principales propias; lo que falta en una fuente sale `null`, nunca 0; el periodo acaba en el último día que tienen las dos fuentes) y `GET /seo-advanced/ga4/page?url=&days=` (`SeoGa4PageDetailDto`, la ficha de una página o de una palabra; 90 días por defecto).
  - Admin (`AdminGuard`): lo mismo bajo `/admin/seo/projects/:id/ga4…`. Leer: cualquier super admin. Conectar, quitar y descargar: el rol superadmin y solo en proyectos de la plataforma (en los de un tenant, 404); auditados `admin.seo.ga4_connected` y `admin.seo.ga4_disconnected`.
  - **Oportunidades**: factor opcional «Mucho tráfico y poca interacción» (`engagement`, peso 0,05 editable, como «La página convierte»): solo entra si la página que sale para la búsqueda tiene al menos 50 sesiones orgánicas de GA4 en el periodo; vale (60 % − interacción) ÷ 60 %. Sin GA4 o sin sesiones suficientes no existe y la puntuación no cambia. Las descargas de GA4 programan el recálculo.
  - **Informe**: `SeoReportContentDto.ga4` (sesiones del periodo frente al anterior, interacción y eventos clave).

- **Visibilidad en buscadores de IA (PR 12)**. Lo puro en shared (`packages/shared/src/seo/ai-visibility.ts`); el API en `apps/api/src/modules/seo-advanced/sistrix/` (`SeoAiVisibilityService`, normalizador y tandas).
  - **Consultas**: dentro de la tanda «Visibilidad en IA» de SISTRIX (`ai_visibility`, mensual por defecto, con la caché, el registro y la cuota de la PR 3), siempre con el país `es` y solo por el MCP (la API clásica no la tiene: espera al MCP): `ai_check` vista `overview` y `prompts` de tu dominio principal, de tu marca (`brandTerms` del proyecto, juntas) y de cada competidor activo; `sources` (`source_type=url`) y `competitors` de lo tuyo; y `ai_prompt_answers` de cada prompt que sigues (hasta 20). Nunca `ai_topicresearch` vista `list` ni `ai_tracker*`. Unas 25–45 consultas al mes por proyecto con 10 competidores y 20 prompts seguidos; por el MCP no gastan créditos.
  - **Datos**: `seo_ai_visibility` gana `subject_type` (`domain` · `brand`; el índice único lo incluye); `seo_ai_prompts` (prompts de cada dominio o marca y respuestas de los seguidos, `subject_type = 'tracked'`, con modelo `aio` · `ai_mode` · `chatgpt` y la respuesta como texto de terceros: SISTRIX la da en HTML en `message` y se guarda solo como texto plano limpio con `seoAiAnswerText`, recortada a 4.000 caracteres; el HTML no llega a la web ni al asistente) y `seo_ai_sources` (fuentes citadas por URL o host con las veces citada —`amount`— y marcas que compiten, `source_type = 'brand'`, sin recuento), histórico por fecha de consulta y proveedor, en el «fondo» de SISTRIX (plataforma o la clave del tenant). Se borran al anonimizar un tenant.
  - Tenant: `GET /seo-advanced/ai-visibility/report` (`analytics:read`; `SeoAiVisibilityReportDto`: cada sujeto —tu dominio, tu marca y tus competidores— con sus prompts de la última consulta y la anterior, su serie y el reparto por modelo; tus prompts con su respuesta; `gaps`, los prompts en los que sale algún competidor y tú no; fuentes, tus páginas citadas y marcas que compiten; los prompts seguidos con la última respuesta de cada modelo y si te nombran) y `PUT /seo-advanced/ai-visibility/tracked-prompts {prompts}` (`settings:manage`; sin repetidos, hasta 20). La consulta se lanza como el resto con `POST /seo-advanced/sistrix/sync {dataType:'ai_visibility'}`. Lo que ya había (`GET /seo-advanced/ai-visibility`) sigue igual (solo dominios).
  - Admin: `GET /admin/seo/projects/:id/ai-visibility/report` (cualquier super admin) y `PUT …/ai-visibility/tracked-prompts` (superadmin, solo la plataforma; auditado `admin.seo.ai_prompts_changed`).
  - **Alerta** `ai_visibility_lost` («Dejas de salir en los buscadores de IA»): prompts en los que salías (tu dominio o tu marca) en la consulta anterior y no en la última; umbral `aiLostPrompts` (1 por defecto); alta si ya no sales en ninguno. Con la deduplicación y la autorresolución de la PR 8. **Informe**: `SeoReportContentDto.aiVisibility` (prompts tuyos, los de la anterior, los perdidos y los 5 competidores con más).
  - **Briefs**: fuente nueva `{source:'prompt', prompt}` («Preparar contenido» desde un prompt en el que sale la competencia y tú no); el prompt llega al modelo delimitado como dato.
  - **Asistente**: herramientas de lectura `seo_ga4_pages` y `seo_ai_visibility`; las respuestas de las IA, los prompts, las fuentes y las páginas van entre `⟦externo⟧` y `⟦/externo⟧`.

### Landings de promoción (`/promo-landings`, extra Web Premium)

Páginas propias por promoción en la web del tenant, con el estilo de su plantilla.

- `GET /promo-landings`, `GET /promo-landings/:id` (`settings:read`); `POST`, `PATCH /:id`, `DELETE /:id`, `POST /:id/duplicate` (copia apagada con dirección `<slug>-copia`) (`settings:manage`). Sin la feature `web_premium` → 403. Errores: 409 `promo_slug_taken`, 400 `invalid_reference` (cupón, local o tamaño de otro tenant), 400 `invalid_dates`.
- Foto principal: `POST /promo-landings/:id/image/upload-url {mimeType, sizeBytes}` (JPG/PNG/WebP ≤5 MB, bucket público) y `PUT /promo-landings/:id/image {heroImageKey|null}` (la clave debe empezar por `<tenant>/promo/<id>/`).
- `PromoLandingDto`: nombre, `slug`, `isActive`, `startsAt`/`endsAt`, `live` (activa y dentro de fechas), titular, subtítulo, oferta, texto, ventajas, condiciones, texto del botón, foto, cupón (`couponId`/`couponCode`), locales y tamaños (vacío = todos), secciones (cuenta atrás, opiniones, preguntas, contacto), SEO e `indexable` (por defecto no).
- **Pública**: `GET /public/landing/:slug/promo/:promoSlug` → `{ site: PublicLandingDto, promo: PublicPromoLandingDto }` (el cupón solo si sigue activo, con `summary` y `minMonths`). Apagada, fuera de fechas, inexistente o sin `web_premium` → 404 `promo_not_available`; la web redirige a la portada.
- **Contenido (2026-10-30)**: `content` (`PromoLandingContent` en shared) con la barra, la portada (antetítulo, dos botones, puntos de confianza), la oferta, los bloques reordenables (ventajas, tamaños con texto por tipo, pasos, promoción, condiciones, opiniones, preguntas y formulario) y su orden. Los botones solo admiten acciones (`book`, `sizes`, `form`, `call`, `whatsapp`), nunca direcciones. Al editar, `content` sustituye al guardado. Si el cupón de la landing ya no se puede usar, la página pública recibe la oferta y el bloque de la promoción apagados.
- **Dirección corta**: `shortPath: true` hace que, con dominio propio, la landing responda también en `/<nombre>` (sin `/promo/`; canónica, enlaces de los canales y sitemap pasan a la corta). Al activarla o cambiar el nombre: 409 `promo_short_path_taken` si coincide con un local, una página de ciudad o zona (`trasteros-en-…`) o una página fija de la web; un local nuevo no puede tomar ese nombre. `GET /public/landing/:slug/promo/:promoSlug?via=short` solo la sirve si la tiene activada (404 `promo_not_found` si no; `promo_not_available` si está apagada o caducada, y la web lleva a la portada).
- **Vista previa**: `POST /promo-landings/:id/preview` (`settings:read`, 200) → `{url, expiresAt}`: enlace firmado (HMAC con `MASTER_ENCRYPTION_KEY`, 30 min) a `/s/<slug>/promo/<nombre>?preview=<token>`; `GET /public/landing/:slug/promo/:promoSlug?preview=` la sirve aunque sea un borrador o esté fuera de fechas (`promo.preview: true`, sin indexar, sin contar visitas ni enviar el formulario).
- **Formulario**: `POST /public/landing/:slug/promo/:promoSlug/lead {name, phone, email?, unitTypeId?, acceptPrivacy: true, acceptsMarketing?, hp, utm*}` (público, 5/min, 200 `{ok: true}`) → contacto con origen `landing`, `utm_campaign` = `promo-<nombre>` y el tamaño y el local que pide (un contacto abierto con el mismo teléfono o email se completa). 400 `invalid_unit_type` (tamaño fuera de la landing o de otro negocio), 400 `invalid_payload` (campo trampa), 404 `promo_not_available` (borrador, fuera de fechas, sin Web Premium) o `contact_disabled`. Cuenta en los resultados como `requests`.
- **Resultados (PR 3)**: `GET /promo-landings/:id/stats?days=` (`settings:read`; 0 = desde siempre, 30 por defecto) → `PromoLandingStatsDto`: visitas y visitantes, reservas online desde la landing (contacto con `utm_campaign` = `promo-<nombre>`), firmadas, pagadas (1ª factura cobrada), ingresos (lo cobrado en esa 1ª factura, sin fianza ni retención), usos del cupón y desglose por origen. Una reserva de un contacto que ya existía toma el origen de la reserva.
- **Origen de la visita** (2026-10-21): la web del tenant guarda en el navegador de dónde vino el visitante (`utm_*`, `gclid`/`fbclid`…, o la web de la que viene; `detectTrafficSource` en shared) y lo envía como `utmSource`/`utmMedium`/`utmCampaign` en `POST /public/move-in/book/:slug`, `…/lead` y `POST /public/landing/:slug/contact` (este último lo acepta desde ahora y lo guarda en el contacto). Las visitas de las landings usan ese origen si el enlace no trae utm.
- **Analítica propia de la web** (2026-10-22): `POST /public/landing/:slug/events {visitorId, kind, path, source?, medium?, campaign?}` (público, 120/min, 204; `kind` = `page_view` | `call_click` | `whatsapp_click` | `email_click` | `directions_click`; los robots se ignoran por el navegador que declaran; una página vista cuenta una vez por visitante y página cada 30 min). `GET /marketing/web-analytics?days=7|30|90` (`marketing:read`) → `WebAnalyticsDto`: totales y periodo anterior (visitantes, contactos, reservas), visitantes por día en la zona del tenant, embudo por origen (visitantes, páginas, llamadas, WhatsApp, email, cómo llegar, contactos web, reservas, firmadas, pagadas, ingresos del primer pago, gasto de los canales con ese `utmSourceMatch` y coste por reserva), 15 páginas más vistas con sus clics de contacto y visitantes por dispositivo.
- **Google Analytics 4** (2026-10-22, `@RequireFeature('web_premium')`): `GET /marketing/ga4` (`marketing:read`) → `Ga4SettingsDto` (cuenta de servicio disponible y su email, propiedad, estado, último error y última descarga); `PUT /marketing/ga4 {propertyId}` (`marketing:manage`; acepta `123456789` o `properties/123456789`) comprueba el acceso y descarga 120 días → 400 `ga4_no_access` (queda guardada con el motivo) o 503 `ga4_not_configured`; `DELETE` borra la conexión y los datos; `POST /marketing/ga4/sync` descarga ya los últimos 6 días; `GET /marketing/ga4/report?days=7|30|90` (`marketing:read`) → `Ga4ReportDto` hasta ayer: sesiones, con interacción, páginas vistas, eventos clave (y el periodo anterior), sesiones por día, por origen/medio, páginas y dispositivos. Cron `ga4.daily` (06:45, worker). Simulado con `NODE_ENV=test`/`GSC_MODE=stub` (la propiedad `403403403` no da acceso).
- **Rendimiento de los anuncios** (2026-10-22): la sincronización de Google Ads y Meta Ads (manual o cron) guarda además impresiones, clics y conversiones de la plataforma por canal y día (`ad_metrics_daily`; Meta cuenta como conversión `lead`, `purchase`, `contact`, `schedule`, `submit_application` y `complete_registration`). `GET /marketing/channels/ads-performance?from=&to=` (`marketing:read`, por defecto los últimos 30 días; 400 `invalid_date`) → `AdPerformanceDto`: por canal de anuncios, impresiones, clics, gasto (de las métricas; si aún no hay, de los gastos vinculados), conversiones de la plataforma, contactos y reservas/firmadas con su `utmSourceMatch`, CTR, coste por clic, por contacto y por reserva, y el último día con datos; más los totales.
- **Instagram y Facebook orgánico** (2026-10-22, `@RequireFeature('web_premium')`): `GET /marketing/social` (`marketing:read`) → `SocialSettingsDto` (página, Instagram vinculado, estado, último error y descarga). `PUT /marketing/social {accessToken, pageId?}` (`marketing:manage`): comprueba el token con Meta, guarda el de la página cifrado y descarga 30 días; 400 `social_token_invalid` (token caducado o sin permisos, con el motivo), `social_no_pages`, `social_choose_page` (varias páginas: `details.pages[]` con `id`, `name`, `instagramUsername`) y `social_page_not_found`. `POST /marketing/social/sync` descarga ya los 3 últimos días; `DELETE /marketing/social` borra el token y lo descargado. `GET /marketing/social/report?days=7|30|90` (`marketing:read`) → `SocialReportDto`: por red, seguidores (último dato) y su cambio, totales y periodo anterior (alcance, visualizaciones, visitas al perfil, clics a la web, interacciones, nuevos seguidores) y alcance por día; las 6 mejores publicaciones (`socialPostScore`: alcance o interacción) y, por red, visitantes, contactos y reservas de la web con ese origen. El resumen de marketing (`MarketingSummaryDto`) suma `current/previous.socialFollowers` y `socialReach` (null sin conectar) y `connections.social`.
- **Puesta en marcha** (2026-10-22): `GET /dashboard/onboarding` (`settings:read`) → `OnboardingDto`: `steps[]` con `key`, `label`, `hint`, `done`, `group` (`required` | `recommended`), `href` y `secondary` opcional (atajo de importación); `progress` y `completed` cuentan solo los imprescindibles; `requiredDone/Total` y `recommendedDone/Total`. El paso `series` solo aparece si el tenant no tiene serie activa; `verifactu` no aparece en modo Holded.
- **Resumen de marketing** (2026-10-22): `GET /marketing/summary?month=YYYY-MM` (`marketing:read`; por defecto el mes pasado en la zona del tenant; 400 `invalid_month`) → `MarketingSummaryDto`: cifras del mes y del anterior (visitantes, clics de contacto, contactos de la web y de cualquier origen, reservas online, firmadas, pagadas, cobrado en el primer pago, gasto en la categoría Marketing, clics de anuncios, sesiones de GA4 y clics de Search Console —null sin conectar—), hasta 8 orígenes con su embudo y gasto, lo conectado y hasta 5 consejos (`marketingSummaryTips`: `warning` primero, luego `good` e `info`, cada uno con la página donde actuar). `PUT /marketing/summary/report {enabled}` (`marketing:manage`, 204) activa o apaga el correo mensual; `POST /marketing/summary/report/send` (`marketing:manage`) envía ya el del mes pasado a los propietarios → `{recipients, month}`.
- **Seguimiento (PR 2)**: `POST /public/landing/:slug/promo/:promoSlug/visit {visitorId, source?, medium?, campaign?}` (público, 30/min, 204; lo manda la página al abrirse; un visitante cuenta una vez cada 30 min; apagada no cuenta). Un canal de marketing con `promoLandingId` (`POST/PATCH /marketing/channels`, 400 `promo_landing_not_found` si no es del tenant) lleva su enlace corto / QR a la landing en vez de a la reserva, y `MarketingChannelDto.landingUrl` da la dirección con `utm_source` = su `utmSourceMatch`, `utm_medium` según el tipo (`cpc`, `paid_social`, `offline`, `referral`, `other`) y `utm_campaign` = `promo-<nombre>`. La landing pasa esas variables a la reserva (sin ellas: `web` / `landing` / `promo-<nombre>`).
- **Enlace corto de un canal** (`MarketingChannelDto.shortUrl`): con dominio propio verificado sale como `https://<dominio>/g/<código>` (si no, `trasteros.pro/g/<código>`); `/g` lo sirve la plataforma también con web externa. `GET /public/marketing/go/:shortCode?tenant=<slug>` (la página `/g/<código>` pasa el negocio del dominio): un código de otro negocio da 404 `short_link_not_found`.

### Textos legales de la web del tenant

- **Pública**: `GET /public/landing/:slug/legal/:doc` (`doc` = `aviso-legal` | `privacidad` | `cookies`, 60/min) → `PublicLegalDocDto` (marca del tenant + `title` + `markdown`). El texto propio si lo hay; si no, el generado con sus datos de facturación (razón social, NIF, domicilio, email) y lo que usa (Google Analytics, WhatsApp). Para todos los planes. Otro `doc` → 404.
- **Ajustes**: `GET /settings/tenant/web-legal` (`settings:read`) → `{texts, generated, holder, missing}`; `PATCH /settings/tenant/web-legal {legalNotice?, privacy?, cookies?}` (`settings:manage`, Markdown ≤30.000; `''` = volver al generado; auditado `tenant.web_legal_changed`).
- **Web**: páginas `/aviso-legal`, `/privacidad` y `/cookies` (dominio propio) o `/s/<slug>/…`, enlazadas en el pie de todas las plantillas. Con GA4 configurado, la web del tenant pide consentimiento (aviso de cookies) antes de cargar Google Analytics y el pie lleva «Configurar cookies».
- En el dominio propio la dirección es `/promo/<nombre>` (también con web externa); en la plataforma, `/s/<slug>/promo/<nombre>`. «Reservar» lleva a la reserva con `?coupon=<código>&months=<mínimo del cupón>` (la reserva los deja puestos). Un local no puede llamarse `promo`.

### Referidos (`/referrals`, `/portal/me/referrals`, `/settings/tenant/referrals`)

- `GET /referrals` + `GET /referrals/stats` (`referrals:read`): lista + métricas.
- `GET /portal/me/referrals` (`@Public` + sesión de portal): código del inquilino + sus referidos + recompensas.
- `GET/PATCH /settings/tenant/referrals` (`settings:read`/`settings:manage`): opt-in + recompensa (`referral_enabled`/`referral_reward_type`/`referral_reward_value`).
- Registro: `referralCode` en el alta de cliente (`CreateCustomerSchema`) y en el booking público (`PublicBookingSchema`). Conversión + recompensa (promoción `REF-XXXX` de un solo uso) por el listener `domain.contract_signed`.

### Campañas segmentadas (`/campaigns`)

- `POST /campaigns/preview` (`communications:send`): cuenta la audiencia (clientes/leads con email) de un `segment` sin crear ni enviar.
- `GET /campaigns` + `GET /campaigns/:id` (`communications:read`).
- `POST /campaigns` (`communications:send`): crea una campaña en borrador (segmento + asunto + cuerpo Handlebars inline).
- `POST /campaigns/:id/send` (`communications:send`): resuelve la audiencia, renderiza por destinatario y encola una `communications` por cada uno (`source=campaign:<id>`). Idempotente (409 `campaign_not_sendable` si no es borrador). v1 solo email. Con `scheduledFor` futuro la campaña queda `scheduled` y pasa a `sent` cuando salen sus correos.
- `POST /campaigns/:id/cancel` (`communications:send`): cancela un borrador o una programada que aún no ha salido (sus correos pendientes quedan `skipped`); 409 si ya salió.
- Segmento: `facilityId` opcional (clientes con contrato en ese local; contactos con ese local preferido). Ex-clientes (`former`) = algún contrato firmado y terminado, ninguno vivo.
- **Resultados** `GET /campaigns/:id/results`: enviados, entregados, rebotes, fallidos, omitidos, bajas tras recibirla y clics. Los enlaces del mensaje salen como `<API>/v1/public/campaign-click/<token>` (`campaign_links`; token firmado con el enlace y el destinatario) y `GET /public/campaign-click/:token` cuenta el clic (uno por persona y enlace) y redirige (302); un token inválido lleva a la web.
- **Plantillas** `GET/POST /campaigns/templates`, `PATCH/DELETE /campaigns/templates/:templateId`; **vista previa** `POST /campaigns/preview-email {subject, bodyText, audience}` → `{subject, html}` con la marca del tenant y un destinatario de ejemplo.
- **Win-back en dos pasos**: `winback-settings` gana `secondEnabled`, `secondDelayDays` (30), `secondSubject`, `secondBodyText` y `secondCouponCode` (cupón activo y no «solo clientes nuevos»: 400 `coupon_not_found` / `coupon_new_customers_only`; activarlo sin cupón → 400 `winback_coupon_required`); `{{coupon.code}}` pone el código. `GET /campaigns/winback/stats` → `{firstSent, secondSent, recovered, recoveryRate}` (recuperado = firmó un contrato después del primer aviso).
- **Audiencia comercial** (LSSI art. 21): clientes sin `marketing_opt_out_at` y leads con `marketing_consent_at` y sin baja. Cada correo lleva enlace y cabeceras de baja.
- `POST /customers/:id/marketing {subscribed}` (`customers:write`): da de baja (o de alta, si el cliente lo pide) de las comunicaciones comerciales.
- `GET /public/unsubscribe/:token` (público): destinatario (email oculto) y si ya está de baja. `POST /public/unsubscribe/:token`: da de baja (idempotente; también lo usa la baja de un clic del cliente de correo). Token firmado, 404 `unsubscribe_link_invalid` si no es válido.
- **Lista de supresión**: `GET /customers/:id/email-status` (`customers:read`) → `CustomerEmailStatusDto {email, suppressions[], undelivered: {at, subject, reason, temporary} | null, suggestion}`: bloqueos del email, su último correo si rebotó o falló (`temporary` = rebote temporal) y el email con el dominio corregido si parece mal escrito (`suggestEmailFix`: `@gmial.com` → `@gmail.com`) + `POST /customers/:id/email-status/clear` (`customers:write`, desbloquea). Panel admin: `GET /admin/email-settings/suppressions?search=&cursor=` + `DELETE /admin/email-settings/suppressions/:id` (superadmin).
- `GET /communications/channels` (`communications:read`): `{ email, whatsapp }` — si WhatsApp puede enviar de verdad. Crear un envío por WhatsApp que no puede salir (manual, automatización, valoración) → 400 `whatsapp_not_available`; los ya creados quedan `skipped` al despachar.
- `GET /communications/page` (`communications:read`): historial paginado por cursor → `{items, nextCursor}`; `search` (destinatario, asunto, inquilino), `from`/`to`, `status`, `channel`, `customerId`, `leadId`, `source`, `limit` (máx. 100).
- `GET/PATCH /me/email-notices` (cualquier usuario): qué avisos por correo al equipo recibe → `{notices: {new_lead, new_booking, move_out_requested, portal_incident}, disabledByTenant}`.
- `GET /admin/email-log` (super admin, también soporte): historial de los correos de la plataforma → `{items, nextCursor}`; `search` (destinatario, asunto, tenant), `tenantId`, `kind`, `status` (un `kind` o `status` que no existe → 400 `invalid_kind`/`invalid_status`).
- `GET /sepa/remittances/:id/prenotices` (`payments:read`): constancia del preaviso de cada adeudo → `[{invoiceNumber, customerName, amount, status (null|sent|disabled|no_email|failed), at, recipient, subject, text, deliveryStatus, itemStatus (pending|collected|failed|returned|cancelled), failureReason}]`. El listado de remesas añade `prenoticesSent`/`prenoticesMissing`.
- `GET /public/landing/:slug` añade `latestBlogPosts` (las 4 últimas entradas publicadas, con Web Premium) y admite la plantilla `onepagemovil`.
- `GET/PATCH /settings/tenant/billing` incluye `firstPaymentNextMonthFromDay` (2-28, `null` = desactivado; 20 por defecto): si el contrato mensual empieza a partir de ese día (y no el día 1), la primera factura cubre también el mes siguiente completo y la recurrente empieza el mes después (`billingStartsOn`). El resumen del primer pago (`POST /public/move-in/book/:slug/quote` acepta `startDate`; el portal usa el día de hoy y la firma la fecha del contrato) trae `firstMonth` (`periodStart`, `periodEnd`, `days`, `daysInMonth`, `includesNextMonth`, `firstMonthRent`, `nextMonthRent`, sin IVA) con el mismo importe que la factura.
- `PATCH /settings/tenant/billing` acepta `transferIban` (IBAN para transferencias, validado; `''` lo quita). Sale en el correo de «Nueva factura» de quien no tiene cobro automático ni domiciliación.

### Subidas de precio / ECRI (`/rent-increases`)

- `POST /rent-increases/preview` (`contracts:manage`): contratos afectados con precio nuevo (% hasta 100 o € hasta 1.000), fecha de cada uno (`effectiveDate`, la del siguiente periodo si paga por adelantado), `raisedThisYear`, `noEmail`, delta de MRR, `excluded` (por motivo: `ending`, `leaving_before`, `housing`, `already_scheduled`, `recently_raised`, `cap_reached`), `earliestDate` y `noticeDays`. Admite `effectiveDate`.
- `GET /rent-increases` + `GET /rent-increases/:id` (`contracts:read`): el detalle incluye los items (cuotas, fecha, estado, motivo y `noticeStatus`: `sent`, `no_email`, `failed`).
- `POST /rent-increases` (`contracts:manage`): programa la subida y envía el preaviso (correo `rent_increase_notice`, con IVA, en el idioma del inquilino). `effectiveDate` es siempre un día 1 (400) y respeta el preaviso de la política (400 `notice_too_short`, `details.minDate`). Un contrato no puede estar en dos subidas a la vez.
- `POST /rent-increases/:id/apply` (`contracts:manage`): aplica los contratos cuya fecha ya llegó (400 `rent_increase_not_due` antes). Cada contrato se reserva antes de tocarlo; si su cuota cambió desde el aviso o pidió la baja, queda sin subir (`price_changed`, `contract_ending`). Lo hace también el proceso `rent-increases.apply` (00:10 de Madrid).
- `POST /rent-increases/:id/cancel` (`contracts:manage`): cancela lo pendiente y avisa a los inquilinos avisados (`rent_increase_cancelled`).
- `GET/PATCH /rent-increases/policy`: `maxAnnualPct` (tope sobre la cuota de hace 12 meses), `minMonthsBetween` y `noticeDays` (1-180). Cambiarla exige ver todos los locales (403 `requires_all_facilities`).
- `increaseType: 'to_list_price'` (preview y crear): sube a cada uno hasta el precio actual de su trastero con un máximo de `increaseValue` %; quien ya paga la tarifa sale en `excluded` como `at_list_price`. Los contratos con «no subir hasta» posterior a la fecha salen como `exempt`. `POST /rent-increases` admite `excludeContractIds` (los que se quitan a mano al repasar la lista).
- `GET/PUT /rent-increases/notice-template` (`contracts:read` / `contracts:manage`, guardar exige ver todos los locales): texto propio del aviso `{ es: {subject, body}, en? }` con variables `{nombre}`, `{trastero}`, `{local}`, `{contrato}`, `{cuota_actual}`, `{cuota_nueva}`, `{fecha}`, `{negocio}`; `null` vuelve al de serie (`defaults`). La baja sin preaviso se añade siempre.
- `POST /rent-increases/notice-preview` (`contracts:manage`): `{subject, text, html}` del aviso con los datos de un contrato (`contractId`, `newPrice`, `effectiveDate`) o de ejemplo; admite `template` sin guardar y `locale`.
- `GET /rent-increases/:id/results` (`contracts:read`): `applied`, `skipped`, `pending`, `plannedMonthly`, `realMonthly` (lo que se cobra de más de los que siguen), `extraInvoiced`, `lostMonthly` y `left` (quien pidió la baja o se fue tras el aviso).
- `POST /rent-increases/:id/items/:itemId/remove` y `…/resend` (`contracts:manage`): quitar a un contrato pendiente (si tenía el aviso le llega la anulación; sin pendientes, la subida queda cancelada o aplicada) o volver a enviarle el aviso (400 `customer_without_email`). Cada item lleva `noticeDelivery` (`pending`, `sent`, `delivered`, `bounced`, `failed`).

### Seguro / protección recurrente (`/insurance-plans`, `/contracts/:id/insurance`)

- `GET /insurance-plans` (`insurance:read`; `?onlyActive=true`) + `POST`/`PATCH /:id`/`DELETE /:id` (`insurance:manage`): catálogo de planes (prima mensual, cobertura, IVA, activo).
- `PUT /contracts/:id/insurance` (`contracts:write`): asigna (`{planId}`) o quita (`{planId:null}`) el seguro; congela la prima en `contracts.insurance_price`. También se asigna en el alta con `CreateContractSchema.insurancePlanId`.
- La prima se factura como una línea recurrente más en la factura mensual del alquiler (`billing-jobs`). `ContractDto` expone `insurancePlanId`/`insurancePlanName`/`insurancePrice`.

### Move-out self-service (portal del inquilino)

- `GET /portal/me/contracts` (`@Public` + sesión de portal): contratos active/ending del inquilino (`PortalContractDto`).
- `GET /portal/me/contracts/pending-signature` (`@Public` + sesión de portal): contratos en borrador que esperan su firma —se le envió el enlace o reservó online— (`PortalPendingSignatureDto[]`: número, trastero, local, inicio, cuota con IVA y `holdUntil`). Los borradores que el equipo aún prepara no salen. `POST /portal/me/contracts/:id/sign-link` (throttle) → `{token}`: enlace de firma nuevo (el anterior deja de valer); 404 si no es suyo o no se le envió a firmar, 409 `contract_not_signable` si ya no está en borrador.
- `POST /portal/me/contracts/:id/request-move-out {endDate}` (`@Public` + sesión + throttle): solicita la baja. Valida propiedad (404 si no es suyo) + preaviso (`endDate ≥ hoy + cancellationNoticeDays`, 400 `notice_period_not_met` con `details.minEndDate`, la primera fecha posible) → contrato a `ending`. Con `moveOutEndOfMonth` (por defecto) la fecha se lleva al último día de su mes. Emite `contract_move_out_requested` → notificación al staff + encuesta de salida (NPS). El staff finaliza el contrato en la fecha (no auto-finaliza).

### Recargo por mora / late fee (`/invoices/:id/late-fee`, `/settings/tenant/billing`)

- `POST /invoices/:id/late-fee` (`invoices:manage`): emite una **factura separada** de recargo (F1, línea sin IVA, % del importe vencido o € fijo según config). Idempotente (409 `late_fee_already_applied`). También lo hace el dunning a los `late_fee_grace_days` de vencimiento si el tenant lo activó.
- `GET/PATCH /settings/tenant/billing` (`settings:read` / `billing:configure`): config del recargo (`lateFeeEnabled`/`lateFeeType`/`lateFeeValue`/`lateFeeGraceDays`) + auto-charge. `InvoiceDto` expone `lateFeeForInvoiceId`/`lateFeeInvoiceId`.

### Accesos del inquilino (`/settings/tenant/access`)

- `GET/PATCH /settings/tenant/access` (`settings:read` / `settings:manage`): `extraAccessLimit` (0-10) — máximo de accesos adicionales que un inquilino puede crearse desde su portal. Auto-emisión de PIN al firmar el contrato y al primer pago (si no tiene credencial).

### Reseñas en Google (`/settings/tenant/reviews`, `/public/reviews/:token`)

- `GET/PATCH /settings/tenant/reviews` (`settings:read` / `settings:manage`): config de auto-solicitud + `googleReviewUrl` (link de Google Business Profile del tenant).
- `POST /public/reviews/:token` (`@Public`): al enviar la valoración devuelve `{ status, googleReviewUrl }`. `googleReviewUrl` solo se rellena si `npsScore >= 9` (promotor) y el tenant configuró el link; la página pública muestra entonces un CTA para reseñar en Google.

### Remesas SEPA (`/sepa/...`)

- `GET /sepa/settings` (`settings:read`) + `PUT /sepa/settings` (`billing:configure`): config del acreedor (nombre, identificador, IBAN cifrado, BIC, `prenoticeDays` 1-30 —días de preaviso de los cargos, 14 por defecto—, enabled). El IBAN es opcional al actualizar (conserva el actual). La previsualización de remesa devuelve `prenoticeDays` para que la web avise si la fecha de cargo no respeta el plazo (y proponga la primera válida).
- `GET /sepa/mandates?customerId=` (`payments:read`) + `POST /sepa/mandates` (`payments:charge`) + `DELETE /sepa/mandates/:id` (`payments:charge`): mandatos por cliente (IBAN validado mod-97 + fecha de firma; crear cancela el activo previo).
- `POST /sepa/remittances/preview` (`invoices:manage`): facturas domiciliables (issued/overdue, cliente con mandato activo, sin remesa) + `withoutMandate`.
- `POST /sepa/remittances` (`invoices:manage`): genera el XML pain.008 + items (facturas quedan "en remesa", no pagadas aún). `GET /sepa/remittances` (`payments:read`).
- `GET /sepa/remittances/:id/xml` (`invoices:manage`): devuelve `{filename, xml}` (el front descarga el blob).
- `POST /sepa/remittances/:id/confirm` (`invoices:manage`), body opcional `{rejectedItemIds?: uuid[]}`: cada adeudo pasa a `collected` (factura pagada, methodType `sepa_debit`) o `failed` (rechazado por el banco, o la factura ya estaba pagada por otra vía → `failureReason`); los mandatos con algún cobro pasan FRST→RCUR. La respuesta trae `collectedCount`/`failedCount`/`returnedCount`. Segunda confirmación → 400 `remittance_not_confirmable`. Si una confirmación se cortó a medias (quedan adeudos `pending` en una remesa `confirmed`, `pendingCount > 0`), volver a llamar la termina sin duplicar cobros (cada cobro lleva la referencia del adeudo en la nota); en los 5 minutos siguientes al inicio → 400 `remittance_confirming`. Lo mismo en `POST /admin/platform-sepa/remittances/:id/confirm`, que ahora reserva la remesa antes de cobrar.
- `POST /sepa/remittances/:id/cancel` (`invoices:manage`): cancela una remesa `generated` (adeudos → `cancelled`); sus facturas vuelven a poder cobrarse y a entrar en otra remesa. 400 `remittance_not_cancellable` si ya está confirmada o cancelada.
- Mientras una factura tiene un adeudo `pending` (remesa sin confirmar), cobrarla por otra vía (`mark-paid`, `charge`, portal, Redsys) → 409 `invoice_in_sepa_remittance`. Lo que ya entró de verdad (conciliación N43, notificación Redsys, liquidación de un expediente) sí se registra; al confirmar la remesa ese adeudo queda `failed` para devolverlo.
- Devolución por N43 (`mark-return`) de una factura cobrada por remesa → su adeudo pasa a `returned` y la factura puede presentarse en otra remesa; si era el primer cobro del mandato, el mandato vuelve a FRST.

### Portal — incidencias (`/portal/me/incidents`)

- `GET /portal/me/incidents` (`@Public` + sesión de portal): incidencias del inquilino.
- `POST /portal/me/incidents` (`@Public` + sesión de portal, throttle): body `{ title, description? }` → crea la incidencia (severity medium) y notifica al staff.

### Reservas, lista de espera y peticiones de trastero: revisión (2026-11-05)

- `POST /reservations`, `POST /reservations/:id/confirm`, `POST /leads/:id/convert`: 409 `unit_held_by_other` si el trastero está guardado para otra persona. `POST /units/:id/change-status` de `reserved` a `available`, igual.
- `POST /reservations`: 400 `invalid_valid_until` (fecha pasada) y 400 `customer_required` (señal sin inquilino). `POST /reservations/:id/confirm`: 400 `reservation_expired`. Confirmar o cancelar dos veces a la vez: 409 `reservation_changed`.
- `POST /waitlist`: 409 `waitlist_duplicate`, 400 `unit_type_not_in_facility`. `PATCH /waitlist/:id`: 409 `waitlist_entry_closed`. `GET /public/waitlist/:slug/options` solo lista locales activos y los tamaños que tienen; `POST /public/waitlist/:slug` da 404 con los demás.
- `POST /contracts`: `waitlistEntryId` sobre otro trastero suelta el guardado; `unitRequestId` cierra la solicitud.
- `PATCH /unit-change-requests/:id` y `PATCH /unit-requests/:id`: rechazar exige `resolutionNote` (400). Avisan por correo (`unit_request_resolved`) y push.
- `POST /portal/me/unit-change-requests`: fecha real y no pasada (400), 409 `unit_change_already_pending`. `POST /portal/me/unit-requests`: necesita trastero, tamaño o una nota de 5 caracteres (400), 409 `unit_request_already_pending`, 400 `unit_not_available`.
- `UnitChangeRequestDto.targetUnitFree`. Los `pending-count` respetan el alcance por local.

### Reservas, lista de espera y peticiones de trastero: mejoras (2026-11-05)

- `GET /units/:id/hold` y `GET /floors/:id/holds` (`customers:read`): quién retiene un trastero (`UnitHoldDto`). `GET /reservations/held-units` (`reservations:read`): todos los reservados.
- `GET/PUT /reservations/settings`: `signalPolicy` (`refund`|`keep`), `waitlistHoldHours` (12-168), `waitlistStaleDays` (0-365). Guardar pide `settings:manage`.
- `PATCH /reservations/:id {validUntil?, customerId?, notes?}`: 409 `reservation_has_signal` si cambia el inquilino con la señal facturada. `POST /reservations/:id/cancel {keepSignal?}`.
- `GET /waitlist/demand`, `GET /waitlist/pending-count`, `GET /waitlist/:id/upcoming-units`, `POST /waitlist/:id/notify` (409 `no_free_unit`), `POST /waitlist/:id/skip` (409 `waitlist_last_in_queue`), `POST /waitlist/:id/requeue`, `POST /waitlist/:id/preassign {unitId|null}` (400 `unit_not_ending`, 409 `unit_already_preassigned`). `WaitlistEntryDto` gana `position`, `holdExpiresAt`, `preassignedUnitId/Code`, `freeUnitAvailable`.
- Público: `GET /public/waitlist/interest/:token` y `POST … {stillInterested}` (204).
- `GET /unit-change-requests/:id/alternatives`. `POST /unit-requests/:id/to-waitlist {facilityId?, unitTypeId?}`.
- `GET /unit-inbox` (`reservations:read`; cambios y solicitudes solo con `contracts:read`), `PATCH /unit-inbox/:kind/:id/assign {userId|null}` (`reservations:write`), `GET /unit-inbox/stats?days=`.

### Cambio de trastero (`/portal/me/unit-change-requests`, `/unit-change-requests`)

- `GET/POST /portal/me/unit-change-requests` (`@Public` + sesión de portal, throttle): el inquilino lista/crea solicitudes `{ contractId?, note }`; al crear notifica al staff.
- `GET /unit-change-requests?status=` (`contracts:read`): cola del staff. `PATCH /unit-change-requests/:id` (`contracts:write`): `{ status: handled|rejected, resolutionNote? }`.

### Portal — notificaciones push (`/portal/me/push/...`)

- `GET /portal/me/push/public-key` (sesión de portal): `{ publicKey }` (null si el push no está configurado — sin VAPID).
- `POST /portal/me/push/subscribe` (sesión de portal, throttle): body `{ endpoint, keys: { p256dh, auth } }` → guarda la suscripción (upsert por endpoint).
- `POST /portal/me/push/unsubscribe` (sesión de portal, throttle): body `{ endpoint }`.
- Web Push (`web-push`) por `VAPID_*`. Listeners `invoice_overdue`/`invoice_paid` envían un push al inquilino.

### Suscripción — pago con tarjeta o Bizum (TPV Redsys de la plataforma, 2026-10-24)

- `GET /admin/platform-redsys/settings` → `RedsysSettingsDto` (la clave nunca se devuelve) y `PUT …/settings` (mismo cuerpo que `/settings/redsys`; solo superadmin; 400 `redsys_secret_required` al activar sin clave).
- `GET /settings/saas-billing/redsys` (`billing:configure`) → `{available, cardEnabled, bizumEnabled, amount, currency, currentPeriodEnd, pastDue, planName, reason}`; `reason` = `not_configured` | `not_manual` (paga por Stripe o SEPA) | `free_plan` | `exempt` | `no_subscription`.
- `POST /settings/saas-billing/redsys/redirect {payMethod?: 'card'|'bizum'}` → formulario firmado (`url`, `signatureVersion`, `merchantParameters`, `signature`). 400 `redsys_not_enabled` / `redsys_not_available` / `bizum_not_enabled`.
- `POST /webhooks/redsys/platform` (público, urlencoded): aviso de Redsys. Pago aprobado → pago de la suscripción `provider: 'redsys'` de un mes (extiende el periodo y emite la factura). Idempotente.

### Equipo — sesión y bloqueo de la app del móvil (2026-10-24)

- **`POST /auth/refresh` con la respuesta perdida**: si se presenta un refresh ya rotado fuera de los 30 s de gracia, pero las sesiones que salieron de él no se han usado y la petición viene del mismo navegador, se sustituyen (`revoked_reason = lost_response`) por una nueva y responde 200. Si alguna ya se usó (o es otro navegador) sigue la detección de reuso: se cierran todas.
- **`X-App-Mode: installed`** (la web la manda cuando corre como app instalada) en `POST /auth/login`, el reto 2FA, aceptar invitación y `POST /auth/refresh`: la sesión dura `JWT_REFRESH_APP_TTL_SECONDS` (90 días) y las que salen de ella al renovar lo heredan.
- `GET /me/app-lock` → `{ pinSet, passkeys: [{id, label, createdAt, lastUsedAt}], idleMinutes }` (cualquier usuario del panel, solo lo suyo).
- `PUT /me/app-lock/pin {pin}` (4-6 cifras; 204) y `DELETE /me/app-lock/pin` (204).
- `POST /me/app-lock/passkeys/options` → opciones WebAuthn de alta (autenticador del dispositivo, verificación del usuario obligatoria); `POST /me/app-lock/passkeys {response, label}` (204; 400 `passkey_invalid` / `passkey_challenge_expired`); `DELETE /me/app-lock/passkeys/:id` (204; 404 `passkey_not_found`).
- `POST /me/app-lock/unlock/options` → opciones WebAuthn de desbloqueo (400 `no_passkeys`); `POST /me/app-lock/unlock/passkey {response}` → `{unlocked: true}` (401 `passkey_unknown` / `passkey_failed`); `POST /me/app-lock/unlock/pin {pin}` → `{unlocked: true}` (400 `wrong_pin` con `details.attemptsLeft`, 400 `no_pin`; al 5.º fallo seguido 401 `app_lock_exhausted` y se cierran todas las sesiones). Ambos con el límite de peticiones del login.

### Equipo — avisos en el dispositivo (`/me/push`, 2026-10-22)

- `GET /me/push?endpoint=` (cualquier usuario del panel): `{ publicKey, subscribed }` (null sin VAPID; `subscribed` = ese dispositivo ya lo tiene activado).
- `POST /me/push/subscribe` body `{ endpoint, keys: { p256dh, auth } }` (204; el mismo navegador pasa a ser de quien lo activa) y `POST /me/push/unsubscribe` `{ endpoint }` (204, solo las suyas).
- Cada notificación del panel de los tipos de `STAFF_PUSH_TYPES` (contacto nuevo, mensaje del inquilino, WhatsApp —mensaje, paso a persona, reserva—, incidencia, baja, trastero adicional o cambio, oferta que interesa, plan de pagos incumplido, alarma de cámara, puerta bloqueada) se envía además como push a los usuarios activos con el push activado que ven ese local (sin local, a todos; sin locales asignados, todo). Las de facturas pagadas y demás se quedan en la campana.

### Asistente IA (`/ai/...`)

- `POST /ai/chat` (`ai:use`): body `{ conversationId?, content }`. Crea la conversación si no se pasa id; el asistente puede invocar herramientas read-only (ocupación, vencidas, métricas, búsqueda/resumen de cliente) ejecutadas con el contexto del tenant **y del usuario**: solo se ofrecen las que su rol permite (métricas e ingresos por mes `analytics:read`, ocupación y disponibilidad `units:read`, vencidas `invoices:read`, clientes `customers:read`, contratos que vencen `contracts:read`, leads `leads:read`, tareas `tasks:read`, incidencias `incidents:read`, gastos `expenses:read`) y los datos se filtran por su `facilityScope`. Devuelve `{ conversationId, message }` (con `toolsUsed`). 503 `ai_not_configured` si el provider anthropic no tiene API key; 503 `ai_busy` si el proveedor está saturado (429/529) o tarda más de 2 min, y 503 `ai_failed` si falla por otro motivo (la consulta no cuenta). Manda los 40 últimos mensajes de la conversación. Si el modelo pide herramientas en la octava vuelta, no se ejecutan. Una respuesta cortada por el tope de tokens lo dice al final.
- `POST /ai/chat/stream` (`ai:use`, 2026-09-28): mismo body y misma lógica que `/ai/chat`, pero responde en **Server-Sent Events** (`text/event-stream`, cabecera `X-Accel-Buffering: no` para que Nginx no retenga el stream). Eventos `data: {…}`: `text` (`delta` de la respuesta), `tool` (`name` de la herramienta que se consulta; el texto previo de esa vuelta no forma parte de la respuesta final), `done` (`conversationId` + `message` guardado, igual que `/ai/chat`) y `error` (`code`, `message`). Los errores previos a abrir el stream (403 sin feature, 503 `ai_not_configured`, 400 de validación) responden como siempre. La web lo usa y cae a `/ai/chat` solo si la petición no llegó a salir. Latido `: ping` cada 15 s. Si el usuario cierra la conexión se deja de llamar al modelo y se guarda «Respuesta detenida» con lo que hubiera escrito.
- **Acciones con confirmación** (2026-09-28): el asistente puede PROPONER (nunca ejecutar) tres acciones mediante herramientas `propose_*`, solo si el rol tiene el permiso: crear tarea (`tasks:write`), recordatorio de pago de una factura pendiente (`communications:send`, respeta `facilityScope`) y mensaje al inquilino por el chat del portal (`customers:write`). La propuesta se valida y se guarda en `ai_pending_actions` (`proposed`); `AiMessageDto.actions` la muestra bajo el mensaje.
  - Tipos: `create_task`, `payment_reminder` (una factura o `invoiceNumbers` hasta 20), `customer_message`, `customer_note` (nota en la ficha) y `customer_followup` (seguimiento con fecha). Estado `expired` para las propuestas de más de 7 días (confirmarlas da 400 `ai_action_expired`).
  - `POST /ai/chat` y `/ai/chat/stream` admiten `about: {type: customer|contract|invoice|unit|facility|lead, id}` (la pregunta se hace desde esa ficha). El stream empieza con el evento `start` (`conversationId`).
  - `GET /ai/suggestions` (`ai:use`): hasta 6 preguntas para empezar según lo que pasa hoy (lo que ve el usuario).
  - `GET/POST /ai/scheduled-questions`, `PATCH/DELETE /ai/scheduled-questions/:id` y `POST …/:id/send` (`ai:use`; cada una es de quien la creó): `{question, frequency: daily|weekly, weekday?, hour}`; la respuesta llega por correo. 400 `too_many_scheduled_questions` (10 activas por persona).
  - `POST /ai/actions/:id/confirm` (`ai:use`): ejecuta con los permisos ACTUALES del usuario y los servicios normales (misma validación y auditoría que desde el panel) → `confirmed` + `resultLink`, o `failed` + `resultError`. Reserva atómica: confirmar dos veces ejecuta una sola vez. Mientras se ejecuta, `status: 'executing'` (si pasa de 10 min se da por fallida: «No se sabe si se completó»). Una acción `failed` se puede volver a confirmar. Auditado `ai.action_confirmed`/`ai.action_failed`.
  - `POST /ai/actions/:id/discard` (`ai:use`): `discarded`; ya no se puede confirmar.
  - Solo el usuario que la propuso puede decidir (otro → 404).
- `GET /ai/conversations` (`ai:use`) + `GET /ai/conversations/:id` + `DELETE /ai/conversations/:id`: scoped por usuario.
- Provider por `AI_PROVIDER=stub|anthropic` (+ `ANTHROPIC_API_KEY`, `AI_MODEL`). El stub permite dev/test sin coste.

### Documentos sin cobrar (2026-11-13)

- `GET /invoices/page` y `GET /invoices/totals` aceptan `hideCancelled=true`: sin los borradores descartados ni los justificantes de fianza anulados (las anuladas por error y con rectificativa se ven). Con `status` explícito no aplica.
- `POST /invoices/:id/cancel` sobre un justificante de fianza sin cobrar (también el que espera al pago): se anula sin rectificativa; 409 `payment_in_progress` con un cobro en curso. Un borrador que espera al cobro con un cobro en marcha tampoco se cancela (409).
- `POST /contracts/:id/cancel` anula además los borradores del contrato y su fianza sin cobrar.
- `GET /invoices/:id` de un justificante que espera al pago: `status: draft`, `issueOnPayment: true`; pasa a `issued` al entrar el cobro o emitirse la factura con la que va.

### Fiscalidad — libros, 303, 347, retenciones, cierre y asesoría (`/fiscal/...`)

- `GET /fiscal/vat-book?from=&to=` (`invoices:manage`): libro registro de facturas expedidas (filas por factura + desglose por tipo de IVA + totales).
- `GET /fiscal/model-303?year=&quarter=` (`invoices:manage`): IVA devengado por tipo del trimestre (parte de IVA repercutido; el soportado lo aporta la asesoría).
- `GET /fiscal/model-347?year=` (`invoices:manage`): clientes con operaciones anuales > 3.005,06 € con NIF y desglose trimestral.
- Solo lectura, derivado de las facturas emitidas (estados ≠ draft/cancelled, por `issue_date`).
- (2026-11-13) `model-303` añade `received` (IVA deducible de los gastos desglosados del trimestre, por tipo), `unbroken` (gastos sin desglosar) y `result` (devengado − deducible). `model-347` añade `cash` por cliente (efectivo cobrado en el año), `suppliers` (proveedores sin los gastos con retención) y `withoutNif`.
- `GET /fiscal/received-book?from=&to=` → libro registro de facturas recibidas (gastos desglosados), con `byRate`, `totals` y `unbroken`.
- `GET /fiscal/withholdings?year=&quarter=` → retenciones practicadas por modelo (`111`, `115`) con sus perceptores, y `received` (las de las facturas a tus inquilinos).
- `GET /fiscal/checks?year=&quarter=` → «Antes de presentar»: `checks[]` (`key`, `severity` error|warning|info, `count`, hasta 20 `items` con enlace), `ended` y el cierre vigente (`closure`).
- `GET /fiscal/closures`; `POST /fiscal/closures {year, quarter}` (400 `quarter_not_ended`, 409 `quarter_already_closed`); `POST /fiscal/closures/:id/reopen {reason}` (`billing:configure`; 404 `closure_not_found`). Con el trimestre cerrado, 409 `fiscal_period_closed` en gastos de ese periodo (crear, cambiar cifras, borrar), su importación y la anulación por error de sus facturas.
- `GET/PUT /fiscal/accountant {email, frequency: off|monthly|quarterly}` (400 `accountant_email_required`) y `POST /fiscal/accountant/send {from, to}` → correo con el enlace al Excel (400 `accountant_email_required`/`email_suppressed`).
- Público: `GET /v1/public/accountant-reports/:token` → 302 al Excel (5 min); 404 `link_expired` pasados 60 días o con un enlace tocado.
- `accountant-export` (tenant y plataforma): `expenses[]` y hoja «Gastos»; `kind=expenses` en CSV.
- `GET /expenses/:id` (`expenses:read`): un gasto (la revisión enlaza a `/expenses?expense=<id>`).

### Conciliación bancaria Norma 43 (`/bank-statements/...`)

- `POST /bank-statements/import` (`invoices:manage`): body `{ filename, content }` (texto del fichero N43); parsea y crea un extracto por bloque de cuenta. 400 `invalid_n43` si no parsea.
- `GET /bank-statements` (`payments:read`): lista de extractos con `matchedCount`. `GET /bank-statements/:id` (`payments:read`): detalle con movimientos; cada **abono** pendiente trae `suggestions` (facturas con importe pendiente exacto) y cada **cargo** pendiente trae `returnSuggestions` (facturas pagadas del mismo importe → devolución SEPA).
- `POST /bank-statements/transactions/:id/match` (`invoices:manage`): body `{ invoiceId }` → marca la factura pagada (bank_transfer) + movimiento `matched`.
- `POST /bank-statements/transactions/:id/mark-return` (`invoices:manage`): body `{ invoiceId }` → devolución SEPA: revierte el cobro (factura a vencida) + movimiento `returned`.
- `POST /bank-statements/transactions/:id/ignore` (`invoices:manage`): marca el movimiento `ignored`.

### Imágenes + slug del local (`/facilities/:id/images`)

- `POST /facilities/:id/images/upload-url` (`facilities:manage`): presigned PUT a MinIO (bucket público `storageos-public`).
- `PUT /facilities/:id/images` (`facilities:manage`): fija la lista completa por keys; valida que cada key empieza por `<tenant>/<facility>/images/` (404 `invalid_image_key`).
- El slug se edita con el `PATCH /facilities/:id` existente (`publicSlug`). `FacilityDto.images = { key, url }[]`; la landing pública las muestra.

---

### Correo saliente (`/admin/email-settings`, `/settings/tenant/email-domain`)

- `GET /admin/email-settings` (super admin): proveedor principal (`brevo`/`resend`/null = variable), respaldo, claves configuradas y orden de envío efectivo. `PUT` (rol superadmin, auditado) y `POST /admin/email-settings/test {to}` (502 `email_send_failed` con el mensaje del proveedor si lo rechaza).
- `GET /admin/email-settings/brevo-domains/unused` (super admin): dominios de la cuenta Brevo que no usa ningún tenant (excluye el de la plataforma y sus subdominios). `DELETE /admin/email-settings/brevo-domains/:domain` (rol superadmin, auditado `admin.brevo_domain.deleted`) → 204; 409 `email_domain_in_use` si lo usa un tenant, 400 `invalid_domain`/`domain_not_allowed`.
- `GET /settings/tenant/email-domain` (`settings:read`) → `{ emailDomain: EmailDomainDto | null }` (envuelto: un `null` crudo llegaría como body vacío).
- `PUT /settings/tenant/email-domain {domain, fromLocalPart?, fromName?, replyTo?}` (`settings:manage`, feature `custom_domain` → si no, 403 `feature_not_in_plan`): da de alta el dominio en la cuenta Brevo de la plataforma y devuelve los registros DNS. Errores: 400 `domain_not_allowed` (dominio de la plataforma), 409 `domain_taken`, 400 `email_domain_provider_error`, 503 `email_domains_not_available` (sin `BREVO_API_KEY`).
- `POST /settings/tenant/email-domain/verify` (`settings:manage` + feature): pide a Brevo que compruebe los DNS y consulta el TXT de propiedad `_trasteros.<dominio>`; `status` `pending` → `verified` solo con ambos (o `failed` si estaba verificado y se rompe). El primer registro de `records` es siempre el de propiedad. `records[].host` va relativo al dominio (`_trasteros`, `brevo1._domainkey`, `@` = raíz). Un dominio que ya existe en la cuenta Brevo se adopta (se consulta con `GET /senders/domains/{d}` antes de crearlo).
- `DELETE /settings/tenant/email-domain` (`settings:manage`, sin feature: se puede quitar tras bajar de plan) → 204. No borra el dominio de Brevo.

## Seguridad — cambios de contrato de la auditoría 4 (2026-09-25)

Detalle y motivación en `docs/AUDITORIA.md` y `docs/ARCHITECTURE.md`
(«Seguridad: primitivas y reglas del código»).

| Endpoint / área                                                                                                           | Cambio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /customers/:id/portal-link/revoke-sessions`                                                                         | **Nuevo** (`customers:write`, 204, auditado `portal.sessions_revoked`): cierra todas las sesiones vivas del portal del inquilino.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /customers/:id/portal-link/send-email`                                                                              | **Nuevo** (`customers:write`, 200 `{sentTo}`, auditado `portal.access_email_sent`): envía al inquilino un correo de bienvenida con su enlace de acceso al portal (un solo uso, 7 días) y el enlace al login para pedir otro; remitente del tenant. 400 `customer_without_email`. El alta del panel lo llama si la casilla «Enviar acceso por email» está marcada (por defecto).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET/PATCH /settings/tenant/customer-emails`                                                                              | **Nuevo** (`settings:read` / `settings:manage`, auditado): correos automáticos al inquilino — `invoice_issued`, `payment_received`, `payment_failed`, `contract_signed`, `contract_ending_soon`, `move_out_confirmed`; todos `true` por defecto. El PATCH acepta solo esas claves (400 si hay otras).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET/PATCH /settings/tenant/staff-emails`                                                                                 | **Nuevo** (`settings:read` / `settings:manage`, auditado): avisos por email a propietarios y gestores — `new_lead` (contacto desde web/widget), `new_booking` (reserva online), `move_out_requested`, `portal_incident`; todos `true` por defecto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /admin/email-settings/platform-domain`                                                                               | Super admin: lista `[{domain, brevo, resend}]`, uno por cada dominio de los remitentes de la plataforma, con `authenticated`/`pending`/`missing`/`no_key`/`error` en cada proveedor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET/PUT /admin/email-settings/senders`                                                                                   | Leer: super admin; cambiar: rol superadmin, auditado `admin.email_senders.updated`. Remitentes de la plataforma — `default` y opcionalmente `account`, `subscription`, `billing`, `admin_messages`, `staff_notices`, cada uno `{name?, email?, replyTo?}` (`''` = vacío; el nombre admite `{tipo}`) — y `tipoLabels` por correo concreto (`null` = texto por defecto, `''` = sin texto). La respuesta incluye lo guardado, `env`, lo `effective` por tipo y `kinds` (texto de `{tipo}` y remitente final de cada correo).                                                                                                                                                                                                                                                                                                                       |
| `GET /automations/runs?ruleId=`                                                                                           | **Nuevo** (`automations:read`, feature `automations`): últimas 50 ejecuciones (de todas las reglas o de una) con estado `succeeded`/`skipped`/`failed` y motivo. `POST`/`PATCH /automations` validan ahora la plantilla (del tenant y del canal de la acción) y rechazan `send_sms`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /webhooks/email-events/brevo?token=` · `POST /webhooks/email-events/resend`                                         | **Nuevo** (públicos, `VERSION_NEUTRAL`): avisos de entrega. Brevo con token en la URL (`EMAIL_WEBHOOK_TOKEN`, 401 si no coincide); Resend con firma Svix (`RESEND_WEBHOOK_SECRET`, cuerpo crudo). Sin la variable → 404. Entregado → `delivered` (también tras un rebote temporal); rebote/bloqueo/email inválido → `bounced`; rebote temporal (Brevo `soft_bounce`, Resend `Transient`) → `bounced` con «Rebote temporal: …», sin bloquear la dirección; error → `failed` (+ notificación al tenant, una por correo, con el email corregido si parece mal escrito). Cada aviso válido anota `platform_email_settings.brevo_events_last_at`/`resend_events_last_at` (Correo saliente: «Último aviso recibido»). Rechazos de correos que no están en `communications` → `super_admin_notifications` (1 por motivo y día). Devuelven `{matched}`. |
| `POST /portal/me/password`                                                                                                | Ahora **200** con una `PortalSessionDto` nueva (antes 204): cambiar la contraseña con la sesión iniciada cierra todas las demás sesiones del portal y este dispositivo sigue dentro con el token devuelto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/portal/me/*`                                                                                                            | 401 **`portal_session_revoked`** si la sesión fue revocada (revocación por el staff, cambio, reset o desactivación de la contraseña del portal).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /auth/password/forgot`, `POST /auth/resend-verification`, `POST /portal/login/request`, `POST /portal/login/forgot` | Responden **204 inmediatamente** y generan el token / envían el email en segundo plano (misma latencia exista o no la cuenta).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /admin/auth/login`                                                                                                  | Cuenta desactivada + contraseña incorrecta → **401** (antes 403 `account_disabled` sin comprobar la contraseña).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POST /auth/2fa/challenge`, `POST /admin/auth/2fa/challenge`                                                              | Tope por usuario (429 `too_many_2fa_attempts`) + anti-replay TOTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST/PATCH /settings/webhooks`                                                                                           | 400 **`webhook_url_not_allowed`** (`details.reason`) si la URL apunta a infraestructura interna (IP privada, nombre sin dominio, `.local`, credenciales en la URL). En el envío, un destino no permitido marca el delivery `failed` sin reintentos. No se siguen redirecciones.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /webhooks/email-inbound`                                                                                            | Nuevos campos opcionales `dmarc`, `dkim`, `spf`, `authenticationResults`. Sin DMARC `pass`, el mensaje se guarda con `senderVerified: false` (`CustomerMessageDto.senderVerified`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Endpoints «register» de ficheros subidos                                                                                  | 400 **`file_too_large`** (> 20 MB); el objeto rechazado (tamaño o contenido) se borra.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /access/credentials`, `POST /access/credentials/:id/rotate`                                                         | El PIN manual pasa a **6–8 dígitos** (antes 4–8). Los PIN existentes siguen verificando.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /portal/me/doors/:deviceId/open`                                                                                    | Ya **no** se bloquea por el lockout del teclado (anti-fuerza-bruta) del dispositivo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Notificaciones                                                                                                            | Nuevo tipo `access.device_locked` al saltar el bloqueo del teclado.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Rate limiting                                                                                                             | La IP es la real del cliente (`TRUST_PROXY_HOPS`, default 1): los límites vuelven a ser por cliente.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Pendiente / Backlog post-MVP

Items pendientes tras cerrar Fases 1-14 (MVP listo para vender):

- **Politica de deprecacion de versiones**: aun no existe ciclo formal de
  retirada de `/v1/`. Por ahora todo legacy redirige 308 indefinidamente.
- **AEAT `getStatus` polling**: Veri\*Factu cubre alta + rectificativas
  (sincronos). La consulta de estado por CSV queda fuera del MVP.
- **Cache diario de `analytics/*`**: si la carga crece, materializar
  `analytics_snapshots`.
- **WhatsApp real**: `WhatsAppProvider` existe como abstraccion; falta
  conectar Meta WABA en produccion (stub actual loggea).
- **GoCardless / Redsys**: `PaymentGateway` esta listo; falta integrar
  proveedores SEPA y TPV bancario.
- **Bulk endpoints**: imports masivos de customers/units/contracts.
- **GraphQL o BFF**: si el frontend crece en complejidad, evaluar.

### Rectificativas y reembolsos (auditoría de facturación, PR 6)

- `POST /invoices/:id/refund` emite además una rectificativa de abono por lo devuelto (asíncrona, también para devoluciones hechas en la pasarela).
- `POST /invoices/:id/rectify`: 400 `rectification_exceeds_original` (abonos por encima del total), 400 `substitution_original_paid` (sustitución de una factura con cobros), 409 `rectification_already_exists` / `invoice_substituted`. Emitir una sustitutiva deja la original `rectified`.
- Justificantes de fianza (`kind: 'deposit_receipt'`): no admiten `issue`, `rectify`, `late-fee` ni `refund` por pasarela (400).
- `POST /bank-statements/transactions/:id/match`: `{invoiceId}` o `{invoiceIds: [...]}` (reparte el ingreso por orden). `mark-return` sigue con `{invoiceId}`.
- `POST /invoices/:id/issue`: 400 `issue_date_before_last` si la fecha de emisión es anterior a la de la última factura de la serie.
- `PUT /admin/platform-billing/holded` acepta `creditNoteSeriesId` (serie de rectificativas «No enviar a Verifactu»). `GET /admin/platform-billing/holded/review` (envíos sin confirmar) y `POST /admin/platform-billing/holded/review/:invoiceId {kind: invoice|credit_note|payment, action: retry|already_in_holded, holdedDocumentId?}` (superadmin).
- Segunda auditoría de facturación: las rectificativas se numeran en la serie de rectificativas (`InvoiceSeriesDto.isRectification`; `PATCH /invoice-series/:id {isDefault:true}` sobre ella → 409 `rectification_series_not_default`). Una rectificativa negativa queda `paid` al emitirse; si compensa a la original se registra un pago `methodType: credit_note`. `POST /invoices/:id/refund` → 400 `over_refund` por encima del dinero cobrado. `POST /invoices/:id/issue` en envío real sin certificado vigente → 400 `aeat_certificate_required`.
- Tarjeta de los inquilinos por Stripe desactivada (`TENANT_CARD_PAYMENTS_ENABLED=false` por defecto): `POST /payment-methods/setup-intent`, `POST /payment-methods`, sus equivalentes del portal y el cobro con un método `gateway: stripe` → 400 `card_payments_disabled`. `GET /payment-methods/options` (`payments:read`) y `GET /portal/me/payments/options` → `{ cardPayments: boolean }`.

- `GET/PUT /settings/invoicing-mode` (`settings:read` / `billing:configure`) → `InvoicingModeDto {mode, pendingMode, pendingFrom, canChangeNow, holdedReady, certificateMissing}`; `PUT {mode: 'app'|'holded'}` (400 `holded_issuing_not_ready`). `PUT /settings/holded` admite `issuingInvoiceSeriesId`/`issuingCreditNoteSeriesId` (deben ir a Veri\*Factu: 400 `holded_series_excluded`); `HoldedSettingsDto.issuingReady`. `InvoiceDto.issuedBy`. En modo Holded, `POST /invoices/:id/issue` → 502 `holded_issue_failed` / 409 `invoice_issue_in_progress`; una rectificativa queda pendiente y se enlaza con `POST /invoices/:id/link-holded {holdedDocumentId}` (`invoices:manage`; 409 `not_awaiting_holded`, 400 `holded_document_not_issued`); `HoldedReviewKind` gana `credit_note_pending`.

- `PUT /admin/platform-billing/settings` admite `pricesIncludeVat` (`PlatformBillingSettingsDto.pricesIncludeVat`). `GET /admin/tenants/:id/billing-summary` y el resumen del tenant llevan `pricesIncludeVat` y `effectiveMonthlyToCharge`; `GET /subscription-plans` (público) lleva `pricesIncludeVat` en cada plan. Guardar los datos de facturación (`POST /settings/saas-billing/billing-details`) o editar el tenant desde el admin (`PATCH /admin/tenants/:id`) con un NIF de otra empresa → 409 `tax_id_in_use`.

- Facturas de suscripción por el negocio propio: `PUT /admin/platform-billing/settings {ownTenantSlug}` exige el mismo NIF que el emisor (400 `own_tenant_tax_id_mismatch`); `PlatformInvoiceDto.ownTenantInvoiceId`; `POST /admin/platform-invoices/:id/rectify` sobre una de ellas → 400 `rectify_in_own_tenant` (se rectifica con `POST /invoices/:id/rectify` en el negocio propio); facturar un pago sin negocio propio con envío real a la AEAT → 400 `own_tenant_required`.

- Webhook de Stripe: `charge.refunded`, `charge.dispute.created` y `charge.dispute.closed` de un cobro de **suscripción** (resuelto por `invoicePayments`) sincronizan el pago (`TenantSubscriptionPaymentDto.refundedAmount`/`disputed`) y abonan su factura; marcar un adeudo de la remesa SEPA de la plataforma como devuelto también la abona.

- `GET /fiscal/accountant-export?from=&to=&format=json|csv|xlsx&kind=invoices|payments|deposits` (`invoices:manage`): exportación para la asesoría del tenant — facturas por tipo de IVA, cobros y fianzas (`AccountantExportDto.deposits`). La de la plataforma (`/admin/platform-billing/accountant-export`) admite también `kind=deposits`.

- `PATCH /customers/:id {depositExempt}` — inquilino sin fianza (sus contratos nuevos salen con fianza 0). `CustomerDto.depositExempt`.
- `PUT /contracts/:id/deposit-payment-method {method: online|cash}` (`contracts:write`, solo borrador; 400 `contract_already_signed`) y `POST /contracts/:id/deposit/collect {methodType: cash|bank_transfer|other}` (`payments:charge`; crea el justificante si no existe y lo marca cobrado; 400 `no_deposit`/`contract_closed`, 409 `deposit_already_collected`). `ContractDto.depositPaymentMethod`/`depositReceipt`; `TodayDto.depositsToCollect`; `ContractSignViewDto.depositPaymentMethod`.

## Novedades de octubre de 2026 (#617–#673)

### Motor de precios y competencia (#622–#629)

- `GET/PUT /analytics/pricing-strategy` (leer `analytics:read`, guardar `units:manage`): ocupación objetivo, cambio máximo por vez, días mínimos entre cambios, posicionamiento por local y mínimo/máximo por tipo.
- `GET /analytics/pricing-suggestions` y `GET /analytics/unit-pricing-suggestions?facilityId=&includeCompetition=` (la competencia se incluye por defecto): `marketPrice`, `marketReferences`, `confidence`, `targetPrice`, `holdReason`, `promotionHint`, `marketTrend` y desglose de factores.
- `GET /analytics/price-change-effects`: por cada cambio de precio de los últimos 12 meses con el trastero libre, días hasta alquilarse frente a la mediana previa del tamaño.
- `POST /competitors/:id/review` (`units:manage`): marca todos sus trasteros como comprobados hoy. `GET /competitors/units/:unitId/history` (`analytics:read`). Cambiar precio o estado de un trastero de la competencia añade una observación.
- Ofertas por trastero: `GET /promotions/unit-offers` (`promotions:read`), `POST /promotions/unit-offers {unitId, freeMonths, validDays}` y `DELETE /promotions/unit-offers/:unitId` (`promotions:manage`); 409 `unit_offer_exists`, 400 `unit_not_available`; usarla en otro trastero → 409 `promotion_not_for_unit`. `AvailableUnitDto.offer` en el portal.
- Leads: `TransitionLeadSchema.lostReasonCode` (a «perdido» sin código → `other`); `LeadsFunnelKpiDto.lostReasons`.

### Panel de administración (#630–#636)

- **Problemas de facturación y dominios propios (2026-11-26)**: `GET /admin/billing-health` devuelve `{ aeatMode, tenants, invoices, invoicesTotal }` (por tenant: `issues`, `verifactuEnabled`, `aeatWarnings`, `unsentRecords/unsentSince/unsentLastError`, `failedSubmissions`, `lastSentAt`, `certificateMissing`, `ownerCertificates`; por factura, `unsent`; `invoices` trae las 50 más recientes). `POST /admin/billing-health/invoices/:invoiceId/resend-aeat {reason}` (superadmin; motivo de 3 a 500 caracteres, 400 sin él). `POST /admin/tenants/:id/custom-domain/verify {force?}` (superadmin; 409 `custom_domain_not_ready` con `details: {featureMissing, hosts, httpsOk}`; `force: true` salta las comprobaciones). `GET /admin/tenants/custom-domains` añade `pausedByPlan`, `activatedAt`, `activatedByName`, `tenantStatus`, `checkedAt`, `checkOk` y `checkIssue`. `POST /admin/tenants/:id/custom-domain/check` y `POST /settings/tenant/domain/check` devuelven también `httpsOk`. `GET /settings/tenant/branding` añade `customDomainPaused` (activo pero en pausa porque su plan no incluye la función).
- `GET /admin/crons` (tareas programadas: última ejecución, siguiente prevista, atrasada), `GET /admin/billing-health` (facturas con problemas en Veri\*Factu, Holded para revisar, certificados), `GET /admin/usage?days=` (correo, IA y almacenamiento por tenant) y `POST /admin/usage/measure-storage` (superadmin).
- **Problemas de facturación y Dominios propios: mejoras (2026-11-26)** (todos `AdminGuard`; el rol soporte lee y consulta, escribir es superadmin). `GET /admin/billing-ops/stuck?all=1` (emisores con registros sin enviar: pendientes, desde cuándo, intentos, último error y próximo reintento) y `POST …/stuck/retry {tenantId, ownerId?}` (superadmin; 400 `nothing_pending`). `GET …/tenants?problem=&search=` (Veri\*Factu por tenant; `problem` = rejected, error, stale, unsent, warnings, certificate, holded o healthy; 400 `invalid_problem`). `GET …/issues?type=&tenantId=&cursor=&limit=` → `{items, nextCursor}` (facturas con problema; `limit` hasta 200). `GET …/invoices/:invoiceId` (ficha: mensaje, código, guía, registro e historial), `GET …/invoices/:invoiceId/xml`, `POST …/invoices/:invoiceId/resend {reason}` (superadmin, motivo ≥3 caracteres) y `POST …/invoices/batch {action: refresh|resend, invoiceIds (1-50), reason?}` (reenviar: superadmin y motivo; devuelve el resultado de cada factura). `GET …/certificates?days=` (calendario, 60 por defecto) y `GET …/other` (otros problemas de emisión). `POST …/notices/preview` y `POST …/notices {tenantId, kind: certificate_expiring|certificate_missing|invoice_rejected|holded_review, message?, credentialId?}` (400 `notice_not_applicable`, 409 `notice_cooldown` con `details.until`, 400 `no_recipients`).
- **Dominios propios (2026-11-26)**: `GET /admin/domains/overview` (última comprobación, casillas, dominio de correo y limpiezas pendientes por tenant + `notifyTenantEnabled`), `POST /admin/domains/:tenantId/check` y `POST /admin/domains/check-all` (comprobación completa: DNS de raíz y `www`, https y certificado), `GET /admin/domains/:tenantId/guide` y `PUT …/checklist {steps}` (superadmin), `GET …/history`, `GET /admin/domains/cleanups` y `POST …/cleanups/:id/done` (superadmin), `PUT /admin/domains/settings {notifyTenantEnabled}` (superadmin).
- `GET /admin/tenants/:id/config` (configuración del tenant, solo lectura y sin secretos).
- Novedades: `GET /product-updates` (las 50 últimas), `GET /product-updates/page?cursor=&limit=` (por páginas, con `readUntil`: lo publicado después estaba sin leer), `GET /product-updates/highlighted` → `{ update }` (la destacada sin leer de los últimos 30 días o null), `GET /product-updates/unread-count`, `POST /product-updates/seen` (no hace nada durante una impersonación; también en solo lectura) (cualquier usuario del tenant; sin marca de lectura, cuenta como leído todo lo publicado antes del alta del usuario); `GET/POST /admin/product-updates`, `PUT/DELETE /admin/product-updates/:id` (escribir: superadmin).
- Soporte: `GET /admin/support/stats?days=` y CRUD `/admin/support/canned-responses` (también el rol soporte). `SupportTicketDto.firstResponseAt`.
- Exportar datos: `POST /settings/data-export` (`rgpd:manage`) y `POST /admin/tenants/:id/data-export` (superadmin) → `TenantDataExportDto {url, expiresAt, counts}` (Excel, enlace de 1 h; incluye propietarios, liquidaciones, emisor, tipo fiscal por línea y retención de IRPF).

### Facturación, cobros y migración (#635–#646)

- Tipo fiscal por línea: `taxCategory` (`S1`, `E1`–`E6`, `N1`, `N2`) en las líneas de crear y rectificar factura; 400 `exempt_line_with_vat` si una exenta o no sujeta lleva IVA.
- `POST /contracts/activate-imported {contractIds, depositCollected, billingStartsOn}` (`contracts:manage`): activa borradores importados sin firma ni avisos; devuelve los que fallan. `ContractDto.billingStartsOn`.
- Importar mandatos SEPA: `GET /imports/sepa-mandates/template`, `POST /imports/sepa-mandates/preview|commit` (`imports:manage` + feature `sepa`). `POST /sepa/mandates` acepta `reference` y `sequenceType`; 409 `mandate_reference_taken`.
- `PATCH /billing/aeat-credentials/me/representative {name}` (`billing:configure`): nombre del representante cuando el certificado es de un administrador o gestoría. `TenantAeatCredentialMetadata.representative`/`certOrganizationNif`.
- `GET /payments/returns?from=&to=&kind=&facilityId=` (`payments:read`): recibos devueltos (devolución bancaria, contracargo, domiciliación devuelta, adeudo rechazado en remesa).

### Cobros del mes, deudores y planes de pago

- `GET /collections-month?month=AAAA-MM&facilityId=` (`payments:read`): lo que vence en el mes por vía de cobro (`auto` = tarjeta o adeudo guardados con el cobro automático activo, `remittance` = mandato SEPA, `manual`), lo pendiente de eso, lo cobrado en el mes por forma de pago, los cobros fallidos y devueltos (con la factura y el motivo), lo que se cobra a mano y sigue pendiente, y el reparto por semanas. 400 `invalid_month`.
- `GET /arrears?facilityId=` (`payments:read`): un inquilino por fila con su deuda vencida, desde cuándo, último recordatorio, recargo aplicado, acceso cortado, siguiente paso del escalado, plan de pago y expediente; totales por antigüedad (0-30, 31-60, 61-90, +90 días).
- `GET /payment-plans?customerId=&status=` (`payments:read`), `POST /payment-plans` (`payments:charge`; `{customerId, invoiceIds?, installmentsCount 2-24, firstDueDate, frequency monthly|biweekly|weekly, graceDays 0-30, notes?, notifyCustomer}`; sin `invoiceIds` toma todas las emitidas y vencidas del inquilino; 400 `nothing_to_split`/`invoice_not_payable`, 409 `invoice_in_payment_plan`) y `POST /payment-plans/:id/cancel` (400 `plan_not_active`). El avance se mide con lo cobrado de esas facturas desde que se creó el plan, aplicado a las cuotas en orden. Mientras el plan está activo, el escalado de impagos, los reintentos de cobro y la remesa SEPA no reclaman esas facturas; un cron diario (`payment-plans.daily`, 07:00) lo cierra al pagarse y lo rompe si una cuota pasa de los días de gracia (aviso al equipo).
- Conciliación N43: `GET/PUT /bank-statements/settings` (guardar: `billing:configure`) y `POST /bank-statements/transactions/:id/undo` (`invoices:manage`, solo las automáticas). `ImportN43ResultDto.autoMatchedCount`, `BankTransactionDto.autoMatched`.
- `PUT /contracts/:id/irpf-retention {pct}` (`contracts:manage`): aplica a las facturas que se emitan después. `InvoiceDto.withholdingPct`/`withholdingAmount`/`amountDue`; pago `methodType: withholding` no monetario.

### Revisión de Cobros (2026-11-11)

- **Alcance por local**: `/bank-statements/*` y las remesas de `/sepa/*` son de toda la empresa → 403 `company_wide_only` para quien solo ve unos locales; los mandatos de `/sepa/mandates` siguen el alcance de sus inquilinos. `GET /collections-month`, `/arrears`, `/payment-plans` y `/collections` validan `facilityId` (400 `invalid_facility_id`); `/payment-plans` admite `?facilityId=`, filtra por los locales del usuario y 400 `invalid_customer_id`; `/collections?status=` y `/dunning?status=` → 400 `invalid_status`. El filtro de local de las facturas ya no deja ver ventas ni pases de otros locales.
- **Conciliación N43**: el fichero se lee con el trazado oficial y se comprueban saldos y totales (`warnings`); el mismo fichero dos veces → 409 `statement_already_imported`; los movimientos que ya estaban en otro extracto no se repiten (`duplicatesSkipped`). `POST …/transactions/:id/match` acepta `surplus: credit|refund` (un abono mayor que lo pendiente sin él → 400 `transaction_surplus`; `credit` lo deja como saldo a favor del contrato, 400 `surplus_needs_contract`); el cobro lleva la fecha del apunte. `mark-return {invoiceId, paymentId?}` solo revierte cobros por banco (400 `return_amount_mismatch`, `payment_not_reverted`). `POST …/transactions/:id/undo` deshace también las conciliaciones a mano, las devoluciones y los ignorados (400 `not_undoable`, 409 `surplus_credit_used`). `DELETE /bank-statements/:id` borra un extracto sin nada conciliado (409 `statement_has_matches`). `BankStatementDto` gana `initialBalance`, `finalBalance`, `pendingCount`, `warnings`; `BankTransactionDto` gana `matchedInvoices`, `unappliedAmount`, `creditContractId` y `canUndo`.
- **Remesas SEPA**: solo facturas (`kind: invoice`); al generar, `omitted` con las que ya no se podían domiciliar. `confirm` solo a partir del día del cargo (400 `collection_date_not_reached`), con los rechazados marcados antes de cobrar y `paidAt` = fecha del cargo; un adeudo cobrado sobre una factura ya pagada o anulada queda `unapplied` (`unappliedCount`, aviso para devolverlo). `POST /sepa/remittances/:id/items/:itemId/return {reason?, returnedOn?}` marca devuelto un adeudo cobrado (400 `item_not_collected`, `invalid_returned_on`) y `POST /sepa/remittances/:id/prenotices/resend` reenvía los preavisos que no salieron. Mandato `replacing`: otra cuenta pendiente de firma; el firmado sigue cobrando hasta que se firme el nuevo. Con las remesas desactivadas → 400 `sepa_disabled`.
- **Caja**: `GET /cash/summary` cuenta en la zona del negocio (400 `invalid_date`, `date_in_future`, 404 `facility_not_found`); trae `bizum`, `refunds` por forma de pago, `refundsTotal`, `returned` (cobros devueltos), `depositReturnsCash` y `expectedCash` = efectivo − devoluciones en efectivo − fianzas devueltas en efectivo. Con el día cerrado, un cobro, devolución, fianza o venta en efectivo de ese día → 409 `cash_day_closed`. `POST /cash/closures/:id/reopen {reason}` (`invoices:manage`; 409 `closure_already_reopened`); `CashClosureDto` gana `reopenedAt`, `reopenedByName`, `reopenReason`. Quien solo ve unos locales no ve la caja de toda la empresa.
- **Formas de pago**: `deposit` (fianza aplicada a una factura: no es dinero nuevo y no cuenta en caja) y `bizum` (también el de Redsys, según con qué pidió pagar). `POST /invoices/:id/refund` acepta `refundMethod` (cómo se devuelve un cobro a mano); cada devolución guarda su forma (`invoice_refunds.method`).
- **Disputas**: una disputa ganada en Stripe o Stripe Connect (`charge.dispute.closed` con `won`/`warning_closed`) vuelve a contar el cobro (evento `domain.payment_dispute_won`; si no se puede, aviso `payment.dispute_won_unapplied`).
- **Cobros del mes, deudores y planes**: `MonthCollectionsItemDto.invoiceStatus`; `ArrearsRowDto.paymentInFlight` (`charge`|`remittance`|null), `ArrearsStepDto.postponed`, `ArrearsDto.actionable`. Planes: 400 `first_due_in_past` e `invalid_date`; se cancelan al anular una de sus facturas (aviso `payment_plan.cancelled`). Área de clientes: `PortalInvoiceDto.planInstallment {amount, dueDate, late}`; `POST /portal/me/invoices/:id/charge {installment?}` y `POST …/redsys-redirect {installment: true}` cobran solo la cuota (400 `no_installment_due`, `installment_alone`).
- **Impagos** (condición 12 del contrato): la deuda del expediente es solo lo vencido. `POST /collections/:id/overlock {notes?, priorNotice?}` exige un recordatorio enviado o `priorNotice` (400 `notice_before_overlock_required`). `POST …/notice {noticeDays ≥ 15, sentAt?, tracking?}` (400 `sent_at_in_future`); `POST …/notice-received {receivedAt}` recalcula el plazo desde la entrega (400 `invalid_received_at`). `POST …/resolution-pending` solo pasado el plazo (400 `deadline_not_reached`). `POST …/resolve-contract` termina el contrato y deja el trastero bloqueado; `POST …/move-goods {custodyLocation}` exige el inventario (400 `inventory_required`) y libera el trastero. `POST …/disposal {disposalType: court_order|written_agreement|abandonment}` (abandono solo tras 8 semanas de custodia: 400 `custody_period_not_over`); `POST …/complete-disposal` exige el documento `disposal_act` (400 `disposal_act_required`). Dos acciones a la vez → 409 `case_changed`; un 2º expediente del contrato → 409 `case_already_open`. `POST …/requirement-pdf {noticeDays?}` usa el plazo del formulario si el envío aún no está registrado (15-180; 400 `invalid_notice_days`) → 400 `customer_address_required` o `case_closed`. `DelinquencyCaseDto` gana `noticeDays`, `noticeTracking`, `noticeReceivedAt`, `contractResolvedAt`, `goodsMovedAt`, `custodyLocation`, `abandonmentFrom`; el detalle, `invoices` (facturas vencidas) y `reminded`. `DelinquencySettlementDto.depositReturnedCents`. Ajustes: `collectionsOpenAfterDays` 8-365 (día del aviso legal del escalado) y `collectionsNoticeDays` 15-180.
- **Escalado**: el aviso legal llega a los `collectionsOpenAfterDays` días; abre el expediente si el negocio los usa y el contrato sigue, y si no avisa al equipo (`collections.long_overdue`). La factura vence desde el día siguiente a su vencimiento en la zona del negocio. Plantilla nueva `invoice_overdue_final_nocut_email` (segundo aviso sin corte de acceso). Avisos al móvil del equipo: `collections.long_overdue`, `collections.case_opened`, `collections.surplus_to_return` y `collections.case_closed_paid`.

### Leads del panel admin (2026-11-12)

Todo bajo `AdminGuard`. Crear su cuenta, enviar propuesta y borrar: rol superadmin (403 si no).

| Método       | Ruta                                                                 | Qué hace                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET          | `/admin/leads?search=&source=&assignedTo=me\|none\|<id>&discarded=1` | Tablero: las fases abiertas (hasta 500; `truncated`/`hiddenOpen` si hay más); Cliente y Perdido, los 50 últimos; `counts` por fase. `discarded=1`: los descartados |
| GET          | `/admin/leads/stats?months=`                                         | Embudo, por origen (leads, con cuenta, clientes, conversión, lo que pagan al mes), motivos de pérdida, mediana de primera respuesta y días hasta pagar             |
| GET          | `/admin/leads/export.csv`                                            | CSV con los filtros del tablero                                                                                                                                    |
| GET          | `/admin/leads/followups?mine=1`                                      | Seguimientos pendientes de los leads                                                                                                                               |
| PATCH/DELETE | `/admin/leads/followups/:followupId`                                 | Hecho, cambiar fecha o responsable / borrar                                                                                                                        |
| POST         | `/admin/leads`                                                       | Alta a mano; 409 `lead_exists` (`details.leadId`) con el mismo email o teléfono                                                                                    |
| GET/PATCH    | `/admin/leads/:id`                                                   | Ficha (actividad, seguimientos y propuestas) / editar datos y responsable                                                                                          |
| POST         | `/admin/leads/:id/move` `{status}`                                   | Nuevo, Contactado o Interesado; 400 `stage_automatic` si ya tiene cuenta                                                                                           |
| POST         | `/admin/leads/:id/lose` `{reasonCode, reason?, recontactOn?}`        | Perdido (con seguimiento si hay fecha); 400 `lead_is_customer`                                                                                                     |
| POST         | `/admin/leads/:id/reopen`                                            | Reabre un perdido                                                                                                                                                  |
| POST         | `/admin/leads/:id/discard`                                           | «No es un lead»: sale del tablero y de las cifras                                                                                                                  |
| POST         | `/admin/leads/:id/restore`                                           | Recupera un descartado; 409 `lead_exists` si otro lead tiene ya su email o teléfono                                                                                |
| DELETE       | `/admin/leads/:id`                                                   | Borra el lead con su actividad, seguimientos y propuestas sin tenant                                                                                               |
| POST/DELETE  | `/admin/leads/:id/activities[/:activityId]`                          | Anotar llamada, demo, reunión, WhatsApp o nota / borrar una de esas (400 `activity_locked` el resto)                                                               |
| POST         | `/admin/leads/:id/followups`                                         | Seguimiento con fecha                                                                                                                                              |
| POST         | `/admin/leads/:id/email` `{subject, body}`                           | Correo al lead (remitente «Contacto web»); 400 `lead_without_email` / `email_suppressed`                                                                           |
| POST         | `/admin/leads/:id/link` `{tenantId}`                                 | Une el lead a un tenant; 409 `tenant_already_linked` / `lead_already_linked`                                                                                       |
| POST         | `/admin/leads/:id/create-tenant`                                     | Alta de su cuenta (cuerpo de `POST /admin/tenants`) y la vincula                                                                                                   |
| POST         | `/admin/leads/:id/quote`                                             | Propuesta del simulador (cuerpo de `POST /admin/tenants/:id/quote-offers`): al lead por correo o, si ya tiene cuenta, a sus propietarios                           |

- `POST /platform-contact` y `POST /auth/register` admiten `utmSource`, `utmMedium` y `utmCampaign` (de dónde vino la visita).
- `PlatformQuoteOfferDto.tenantId`/`tenantName` admiten nulo y ganan `leadId`/`leadName`; `acceptUrl` lleva al registro si es de un lead sin cuenta.
- `AdminTodayDto`: `contactMessages` pasa a `newLeads` (leads nuevos sin atender) y se añade `leadFollowupsDue`; el aviso diario por chat los cuenta. Tipo nuevo de «apartar»: `lead_followup`.

### Revisión de los leads del panel admin (2026-11-22)

- **CSV**: las exportaciones del panel admin (leads, contacto de la web, correos enviados, facturas de suscripción, Negocio y Finanzas) ponen un apóstrofo delante de los textos que empiezan por `=`, `+`, `-`, `@`, tabulador o retorno de carro (Excel los tomaría por fórmulas). Los números no cambian.
- `PATCH /admin/leads/:id`: cambiar el email o el teléfono a los de otro lead → 409 `lead_exists` (`details.leadId`). Cambiar el responsable mueve la cartera de comerciales: a un comercial, a su cartera; a otra persona o a nadie, sale de la del comercial. Si su cuenta ya es cliente de un comercial (`tenants.sales_rep_id`), la cartera no se toca y la ficha lo dice en `accountKeptBy {id, name}`.
- **Fechas**: seguimientos (crear y cambiar fecha) y `recontactOn` → 400 `invalid_date` (no existe) o `date_in_past` (hoy en hora de España vale). Actividades: `occurredAt` futura → 400 `date_in_future` (5 min de margen); una llamada, demo, reunión o WhatsApp de antes cuenta como primera respuesta en su fecha.
- `GET /admin/leads/:id` abre también un descartado (`discardedAt`); el resto de acciones sobre él dan 404 hasta recuperarlo.
- `PlatformLeadDto` gana `awaitingReplySince` (desde cuándo espera respuesta: un perdido que vuelve a escribir vuelve a «Nuevo» y cuenta desde ese mensaje; también el aviso de «sin atender» y «Hoy»), `discardedAt`, `salesRepName` y `accountKeptBy`. `PlatformLeadBoardDto` gana `truncated` y `hiddenOpen`. Motivo de pérdida nuevo `churned` («Cliente que se dio de baja»), que solo pone el sistema (`LosePlatformLeadSchema` no lo admite).
- **Fases automáticas** (cada 15 min): una prueba terminada pasa a «Perdido» solo pasados 7 días del fin (`PLATFORM_LEAD_TRIAL_LOST_GRACE_DAYS`), con la cuenta en solo lectura (o de baja) y sin un cobro en marcha (adeudo SEPA en remesa, Redsys `charging`, pago `pending`/`processing`). Un cliente cuya cuenta se cancela, se suspende o se anonimiza pasa a «Perdido» con `churned`; si vuelve a pagar, otra vez «Cliente». Perder un lead (a mano o solo) cierra sus seguimientos pendientes; pasar a cliente cierra el «Volver a contactar» automático.
- `GET /admin/leads/stats`: el periodo empieza el día 1 del mes de hace N-1 meses en hora de España. `funnel` cuenta solo los leads que se trabajan y por las fases por las que pasaron de verdad (con fecha); `direct {leads, customers}` son los que entraron ya en prueba (registro o cuenta creada desde el panel). `churned` aparte de `lost` (y fuera de `lostReasons`). `medianFirstResponseHours` solo con los que escriben solos (formulario, demo, calculadora). `mrr` y `bySource[].mrr`: la cuota sin IVA de Métricas (con atrasados, anual/12 y descuento).
- Registro de acciones (`admin.platform_lead.*`): `updated` (solo los nombres de los campos), `moved`, `lost`, `reopened`, `restored`, `activity_deleted`, `followup_created`, `followup_updated`, `followup_deleted`, `email_sent` y `quote_sent` (este, solo si el correo sale).
- `POST /admin/leads/:id/quote`: si el correo no sale (p. ej. 400 `email_suppressed`), la propuesta no se queda creada. Lo mismo con cuenta (`POST /admin/tenants/:id/quote-offers`) si falla el envío.

### Mejoras de los leads del panel admin (2026-11-22)

Todo bajo `AdminGuard`. Ajustes y secuencias (escribir): rol superadmin. La captura rápida también la usan los comerciales (`@SalesAccess`).

| Método       | Ruta                                                                                                                                                     | Qué hace                                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET          | `/admin/leads/list?search=&source=&assignedTo=&status=a,b&sizeMin=&sizeMax=&city=&campaign=&inactiveDays=&stale=1&discarded=1&sort=&dir=&cursor=&limit=` | Vista de lista: filtros, orden por columna (`score`, `value`, `name`, `company`, `status`, `source`, `city`, `assignee`, `lastActivity`, `nextFollowup`, `createdAt`) y páginas (`cursor` = desplazamiento, `limit` hasta 200) → `{items, nextCursor, total, totalValue}`; 400 `invalid_filters` |
| POST         | `/admin/leads/bulk`                                                                                                                                      | Lote: `{action: assign, ids, assignedToId}`, `{action: move, ids, status}`, `{action: lose, ids, reasonCode, reason?}`, `{action: discard, ids, reasonCode, reason?}` o `{action: followup, ids, title, dueDate, note?}` (hasta 200) → `{done, failed: [{id, name, message}]}`                   |
| GET          | `/admin/leads/export.csv?ids=a,b`                                                                                                                        | CSV de los elegidos (hasta 500); sin `ids`, el de siempre. Columnas nuevas: puntuación, cuota prevista y motivo de descarte                                                                                                                                                                      |
| POST         | `/admin/leads/duplicates` `{companyName?, contactName?, email?, phone?, excludeId?}`                                                                     | Posibles duplicados (aviso, no bloqueo): leads con el mismo email o teléfono o una empresa parecida y cuentas con ese email de usuario, un nombre parecido o el mismo NIF                                                                                                                        |
| GET/PATCH    | `/admin/leads/settings`                                                                                                                                  | Reparto (`assignMode` off·round_robin·zone, `roundRobinIds`, `zoneRules`, `zoneFallbackRoundRobin`), plazo de primera respuesta (`responseHours`, `businessHours`, `reassignEnabled`), parados (`staleDays`, `highValueMonthly`) y `sequenceAutoStart`; PATCH superadmin, 400 `invalid_assignee` |
| GET          | `/admin/leads/templates`                                                                                                                                 | Plantillas de correo activas (las de «Materiales y plantillas» de los comerciales)                                                                                                                                                                                                               |
| GET/POST     | `/admin/leads/sequences`                                                                                                                                 | Secuencias de correos (`steps: [{day, templateId?, subject?, body?}]`, `isActive`, `isDefault`, `activeCount`); POST superadmin, 400 `template_not_found`                                                                                                                                        |
| PATCH/DELETE | `/admin/leads/sequences/:sequenceId`                                                                                                                     | Editar / borrar (con leads que la usaron se desactiva y se para donde esté en marcha); superadmin                                                                                                                                                                                                |
| POST         | `/admin/leads/import/preview` `{csv, format, onDuplicate: skip\|merge, source, assignedToId?}`                                                           | Vista previa (CSV o Excel): `ImportPreviewDto` con lo que pasa con cada fila; 400 `too_many_rows` (2.000)                                                                                                                                                                                        |
| POST         | `/admin/leads/import/commit`                                                                                                                             | Importa: `ImportCommitDto` (con `merge`, a los repetidos se les suman los datos que les faltan y una nota)                                                                                                                                                                                       |
| POST         | `/admin/leads/capture/photo-upload-url` `{mimeType}`                                                                                                     | Subida de la foto de su tarjeta (JPG, PNG o WebP); también comerciales                                                                                                                                                                                                                           |
| POST         | `/admin/leads/capture` `{contactName?, companyName?, email?, phone?, note?, source?, photoKey?}`                                                         | Alta rápida → `{leadId}`; un comercial la da de alta en su cartera (con las reglas de sus prospectos); 400 `invalid_photo`                                                                                                                                                                       |
| POST         | `/admin/leads/:id/discard` `{reasonCode?, reason?}`                                                                                                      | Ahora con motivo: `spam`, `supplier`, `support`, `existing_customer`, `other` (por defecto); `merged` solo lo pone la fusión                                                                                                                                                                     |
| POST         | `/admin/leads/:id/merge` `{sourceId}`                                                                                                                    | Une otro lead a este (actividad, seguimientos, propuestas, citas y datos vacíos); el origen queda descartado como «Fusionado» (`mergedIntoId`); 400 `same_lead`, 409 `both_have_account`                                                                                                         |
| POST         | `/admin/leads/:id/sequence` `{enabled, sequenceId?}`                                                                                                     | Activar (409 `sequence_active`, 400 `sequence_not_open`/`lead_without_email`) o parar los correos automáticos de un lead (y que no empiecen solos)                                                                                                                                               |
| POST         | `/admin/leads/:id/attachments/upload-url` `{mimeType}`                                                                                                   | Subida de un adjunto (imagen o PDF, 10 MB) para un correo al lead                                                                                                                                                                                                                                |

- `POST /admin/leads/:id/email` admite `attachments` (hasta 5, ya subidos; van como enlaces de 7 días en el correo). Con `INBOUND_EMAIL_DOMAIN`, los correos a un lead (también propuesta y secuencias) salen con su dirección de respuesta `p-<token>@<dominio>` y `POST /webhooks/email-inbound` deja la respuesta en su conversación (`email_in`, con adjuntos), marca que espera respuesta, para la secuencia y avisa a quien lo lleva (`platform_lead.email_reply`). `PlatformLeadDetailDto.repliesToThread`.
- `PlatformLeadDto` gana `score` y `scoreFactors` (0-100 con sus motivos), `estimatedMonthly`/`estimatedPlanName` (cuota prevista sin IVA), `highValue`, `staleDays`, `responseDueAt`, `proposalOpens`, `discardReasonCode`, `discardReason` y `mergedIntoId`; el detalle, `sequence`, `sequenceOptOut` y `duplicates`; las actividades, `attachments`. `PlatformLeadBoardDto.valueByStage` («€ en juego» por fase). Actividad nueva `email_in`.
- `PlatformQuoteOfferDto.openCount` y `lastOpenedAt`: cada apertura del enlace cuenta; la primera avisa a quien lleva el lead (o a quien la envió) una sola vez por propuesta y deja «Ha abierto la propuesta» en su actividad.
- `GET /admin/leads/stats?months=&source=`: gana `source`, `stageDays` (días de media en cada fase), `byAssignee`, `byCampaign`, `discardReasons`, `previous` (el periodo anterior de la misma duración) y `valueByStage`.
- `AdminTodayDto.staleLeads` (leads parados; urgentes solo los de alto valor) y tipo nuevo de «apartar»: `stale_lead`. `/admin/saved-views` admite `page=leads`.
- Avisos nuevos del super admin: `platform_lead.assigned`, `platform_lead.reassigned`, `platform_lead.stale`, `platform_lead.email_reply`. Registro de acciones: `admin.platform_lead.discarded` (con motivo), `merged`, `bulk`, `imported`, `sequence_started`, `sequence_stopped`, `settings_changed`.

### Local de las facturas sin contrato (2026-11-12)

- `POST /invoices` admite `facilityId` (uuid o `null` = toda la empresa) en una factura sin contrato; sin indicarlo, el único local del negocio (o el de quien la crea, si solo ve uno). Con contrato se ignora: es el de su trastero. 404 `facility_not_found`; fuera del alcance, 403 `facility_not_in_scope`.
- `InvoiceDto.facilityId`/`facilityName`: el local del contrato, el de la propia factura o el de su venta. El alcance por local de la ficha, los recordatorios y el resto de acciones usa ese mismo local.

### Mejoras de Cobros (2026-11-11)

- **Deudores y Cobros del mes**: `ArrearsRowDto` gana `invoices` (las vencidas, de la más antigua a la más nueva), `snoozed` (apartado desde aquí o desde «Hoy») y `portalUrl`; `actionable` ya no cuenta los apartados. `POST /arrears/:customerId/payment {amount, methodType, notes?}` (`invoices:write`, alcance por local) reparte el pago entre sus facturas vencidas, la más antigua primero → `{applied, failed, remaining}`; pagar solo una parte de una factura, solo en efectivo (400 `partial_only_cash`); 400 `no_overdue_debt`, `amount_exceeds_debt`; 409 `payment_in_progress`. `MonthCollectionsDto` gana `outstandingByVia` (lo que falta por vía), `collectionRate` (de lo vencido, lo cobrado) y `previous` (el mes anterior).
- **Caja**: `POST /cash/movements {date, facilityId?, kind: opening_float|change_in|bank_withdrawal, amount, notes?}` y `DELETE /cash/movements/:id` (`payments:charge`; con el día cerrado 409 `cash_day_closed`; 404 `movement_not_found`). `GET /cash/summary` gana `movements`, `movementsIn`, `movementsOut`, `lastOpeningFloat` y `cashLines` (cada cobro, devolución o fianza en efectivo del día); `expectedCash` suma los movimientos. `POST /cash/close` admite `denominations` (`{"<céntimos>": unidades}`; 400 `denominations_mismatch` si no suma lo contado); `CashClosureDto` gana `denominations` y `breakdown`. `GET /cash/closures?month=AAAA-MM&facilityId=` (400 `invalid_month`) y `GET /cash/closures/:id/pdf` (`payments:read`, el PDF). `TodayExtrasDto.cashUnclosed`.
- **Recibos devueltos**: `POST /invoices/:id/payments/:paymentId/returned {returnCode?, reason?, returnedOn?}` (`invoices:manage`) marca devuelto un cobro por transferencia o domiciliación sin N43 (400 `not_a_bank_payment`, `invalid_returned_on`, `nothing_to_revert`; 404 `payment_not_found`); si era el adeudo de una remesa, el adeudo también. `POST /invoices/:id/return-fee {sourceId}` (`invoices:manage`) carga los gastos por recibo devuelto de la plantilla del contrato en una factura aparte sin IVA (400 `no_return_fee`; 404 `returned_receipt_not_found`; 409 `return_fee_already_applied`). Códigos de devolución SEPA (`returnCode`: AM04, MD06…) en el cobro y en el adeudo; la conciliación N43 lo toma del concepto si viene. `ReturnedReceiptDto` gana `returnCode`, `customerReturns12m`, `chargeable`, `returnFeeInvoiceId` y `returnFee`; los totales, `repeatCustomers`.
- **Impagos**: `POST /collections/:id/remove-overlock {notes?}` (400 `no_overlock`, 409 `overlock_already_removed`), `POST …/surplus-returned {notes?}` (400 `no_surplus`, 409 `surplus_already_returned`), `POST …/charges {kind: transfer|custody|other, amount, description?}` (factura F1 al 21 %; 400 `case_closed`), `POST …/pickups/:pickupId/approve {date, from, to, notes?}` (código de un solo uso en la franja si los bienes siguen en el trastero; 409 `pickup_not_pending`, 400 `pickup_in_past`), `…/reject {reason}`, `…/done` (409 `pickup_not_approved`), `POST …/custody-act-pdf {items, witnesses?}` (400 `contract_not_resolved`), `POST …/dossier-pdf` y `POST …/monitorio-pdf` (400 `no_debt`) → `{url}`; todo `collections:manage`. Un expediente en pausa (plan de pagos activo) no avanza: 409 `case_paused` salvo cerrarlo. `DelinquencyCaseDto` gana `pausedAt`, `paymentPlanId`, `overlockRemovedAt`, `surplusCents`, `surplusReturnedAt`; el detalle, `noticeChecklist`, `pickups` y `charges`. Área de clientes: `GET /portal/me/collections` y `POST /portal/me/collections/:id/pickup {preferredDate, preferredTime: morning|afternoon|any, note?}` (400 `pickup_not_available`, `invalid_preferred_date`; 409 `pickup_already_requested`). Evento `domain.payment_plan_status`. Avisos al móvil del equipo: `collections.deadline_soon`, `collections.abandonment_possible`, `collections.stalled`, `collections.pickup_requested`, `collections.plan_broken`. `TodayExtrasDto.collectionsAlerts`.
- **Escalado**: `GET /dunning/settings` (`settings:read`) y `PUT /dunning/settings` (`settings:manage` + `billing:configure`) con `firstReminderDays` (1-30), `secondReminderDays` (2-60), el recargo, el corte de acceso y `legalNoticeDays` (8-365); `templates` dice qué plantillas usa cada recordatorio.
- **Remesas SEPA**: `PUT /sepa/settings` admite `autoPrepare` y `autoPrepareDay` (1-28). `GET /sepa/remittances/:id` (`payments:read`). `POST /sepa/remittances/bank-response {filename, content}` (`invoices:manage`) lee la respuesta del banco (pain.002) → `{remittanceId, remittanceName, rejected, returned, accepted, alreadyProcessed, unmatched}`; 400 `invalid_pain002`. `SepaRemittanceDto` gana `autoPrepared` y `bankResponseAt`; `SepaRemittancePrenoticeDto.returnCode`. Avisos: `sepa.remittance_prepared`, `sepa.remittance_auto_failed`, `sepa.remittance_unconfirmed`, `sepa.mandates_expiring`.
- **Conciliación**: `POST /bank-statements/import-csv {filename, content, mapping?}` (`invoices:manage`): el CSV de la banca online; sin `mapping`, las columnas se reconocen por su título (400 `csv_columns_unknown` con `details {headers, sample}` para elegirlas; 400 `invalid_bank_csv`; los mismos 409 que el N43). `POST …/transactions/:id/match` admite `rememberPattern` (crea o corrige una regla para ese inquilino). `POST …/transactions/:id/match-remittance {remittanceId}` concilia el abono de una remesa (la registra si aún no lo estaba; 400 `not_a_credit`, `remittance_amount_mismatch`; 404 `remittance_not_found`; 409 `remittance_already_matched`). `POST …/transactions/:id/expense {category, description?, facilityId?, rememberPattern?}` (`invoices:manage` + `expenses:manage`; 400 `not_a_debit`); deshacer borra el gasto. `GET /bank-statements/rules`, `POST /bank-statements/rules {pattern, kind: customer|expense, customerId?, expenseCategory?}` y `DELETE /bank-statements/rules/:ruleId` (400 `rule_pattern_too_short`). `BankStatementDto.source` (`n43`|`csv`) y `balancesKnown` (false si el CSV no trae saldos: no se comprueban ni se enseñan); `BankTransactionDto` gana el estado `expense`, `remittanceSuggestions`, `matchedRemittance`, `expense`, `expenseSuggestion` y `payerPattern`; `BankTransactionSuggestionDto.reason` (`reference`|`rule`|`payer`|`amount`|`sum`) y, para varias facturas, `invoiceIds`/`invoiceNumbers`.

### Viviendas (#642–#645)

- `unit_types.propertyKind` (`storage`|`housing`); marcar un tipo como vivienda exige la feature `housing` (403 `feature_not_in_plan`).
- `PATCH /settings/tenant/contract-template` acepta `housingClauses` (plantilla de vivienda aparte) y `autoEndContracts` (cerrar solas las bajas al día siguiente de su fecha; activado por defecto).
- Contrato v2 (2026-11-11): `GET/PATCH /settings/tenant/contract-template` añaden `moveOutEndOfMonth` (la baja surte efecto a final de mes; por defecto sí), `depositReturnDays` (1-60, 15) y `returnedPaymentFee` (€ sin IVA, 0-100; 0 o null = ninguno). Las variables de las cláusulas ganan `{{moveOutRule}}` y `{{depositReturnDays}}`. `ContractDto.moveOutEndOfMonth` y `PortalContractDto.moveOutEndOfMonth`: la regla con la que se firmó el contrato (la baja y su fecha mínima la usan; cambiar el ajuste del negocio solo afecta a los contratos que se firmen después). `GET /contracts/:id/move-out` → `prepaidCredit` cubre también el primer pago de varios meses y calcula lo usado a la cuota mensual, sin el descuento del prepago.
- Desistimiento (2026-11-11), solo en los contratos que un particular firma por enlace (no en viviendas):
  - `GET /public/move-in/sign/:token` → `withdrawal {applies, deadline, immediateStartRequired}`. `POST /public/move-in/sign/:token` acepta `immediateStart`: si el alquiler empieza dentro de los 14 días es obligatorio (400 `immediate_start_required`). Al firmar se guardan `contracts.withdrawal_deadline` e `immediate_start_requested_at`.
  - `ContractDto` y `ContractSigningRecordDto` ganan `withdrawalDeadline`, `immediateStartRequestedAt` y `withdrawnAt`; `PortalContractDto.withdrawalDeadline` solo mientras se puede desistir.
  - `GET /contracts/:id/withdrawal?communicatedOn=` (`contracts:read`) y `GET /portal/me/contracts/:id/withdrawal` → `ContractWithdrawalDto {allowed, reason, deadline, communicatedOn, immediateStartRequested, usedDays, rentPaid, rentKept, rentRefund, depositRefund}`. `reason`: `not_applicable`, `deadline_passed`, `not_signed`, `pre_opening` o `closed`.
  - `POST /contracts/:id/withdraw {communicatedOn?, note?}` (`contracts:manage`) y `POST /portal/me/contracts/:id/withdraw` (hoy): devuelven lo cobrado de cada factura menos los días usados si pidió empezar ya, la fianza entera, anulan lo no cobrado y cancelan el contrato (aviso `contract.withdrawn` al equipo y correo de acuse al inquilino). 400 `withdrawal_not_allowed` (`details.reason`), 400 `invalid_communicated_on` (fecha futura o anterior a la firma), 409 `already_withdrawn`.
- Depósito de la fianza: `PUT /contracts/:id/deposit-registry`, `POST /contracts/:id/deposit-registry/receipt-upload-url` (`contracts:write`) y `GET /contracts/:id/deposit-registry/receipt` (`contracts:read`); 400 `not_housing`. `TodayDto.depositsToRegister`.
- Actualización anual: `GET/PUT /contract-anniversaries/settings` (guardar exige ver todos los locales), `GET /contract-anniversaries/due` (`contracts:read`; cada fila con `pct`, `customPct`, `late` y `raisedThisYear`; no salen los marcados «no subir hasta» después del aniversario; no salen los que ya tienen otro cambio de cuota, los que se van antes ni los que ya subieron para ese aniversario) y `POST /contract-anniversaries/apply {contractIds, action: apply|skip}` (`contracts:manage`; con el aniversario por llegar queda programada para ese día —`scheduled` en la respuesta— y siempre avisa al inquilino).

### Propietarios — plan Administrador (#647–#653)

Todo con la feature `multi_owner`.

- `GET/POST /owners`, `PATCH /owners/:id` (leer `facilities:read`, cambiar `facilities:manage`; 409 `owner_tax_id_taken`; 409 `owner_tax_id_locked` al cambiar el NIF de uno con facturas emitidas; 409 `owner_has_facilities` al desactivar uno con locales). Trasladar un contrato a un trastero de otro local (`POST /contracts/:id/change-unit`) le pone el propietario de ese local. Asignar un propietario a un local: `PATCH /facilities/:id {ownerId}` (400 `owner_not_found`). `FacilityDto`/`ContractDto`/`InvoiceDto` llevan `ownerId`/`ownerName`.
- Contratos creados antes de asignar el propietario al local (p. ej. importados): `GET /facilities/:id/contracts-without-owner` → `{count}` (`facilities:read`) y `POST /facilities/:id/apply-owner-to-contracts` → `{updated}` (`facilities:manage`; 400 `facility_without_owner`). Las facturas ya creadas no cambian de emisor.
- Certificado del propietario: `GET /owners/:ownerId/aeat-credential` (`invoices:manage`), `POST`/`DELETE` (`billing:configure`).
- Liquidaciones: `GET /owners/:ownerId/statements/preview?from=&to=`, `GET /owners/:ownerId/statements` y `POST /owners/:ownerId/statements {from, to, send}` (`invoices:manage`; 400 `owner_without_email`).
- Fiscalidad por emisor: `?ownerId=` (vacío o `self` = el propio negocio) en `/fiscal/vat-book`, `/fiscal/model-303`, `/fiscal/model-347`, `/fiscal/accounting-export` y `/fiscal/accountant-export`; 400 `invalid_owner`. Crear una factura con una serie de otro emisor → 400 `series_owner_mismatch`.

### Web de TrasterOS (#649, #654–#656)

- Públicos: `GET /platform-founder-offer` → `{offer}` (null si está desactivada), `GET /platform-website` → `{logoUrl, contactForm, footer}` y `POST /platform-contact` (formulario; honeypot `hp`, `acceptPrivacy` obligatorio; 404 `contact_form_disabled`, 400 `phone_required`; límite por IP).
- SEO: `PUT /admin/platform/website/seo` (título, descripción, verificaciones de Google y Bing, GA4 `G-…`, `indexable`, nombre de la empresa), `POST /admin/platform/website/og-image-upload-url` y `PUT /admin/platform/website/og-image {key|null}` (superadmin). `GET /platform-website` incluye `seo` (con `ogImageUrl`).
- Admin (`/admin/platform/...`, escribir: superadmin): `GET/PUT founder-offer`; `GET website`, `POST website/logo-upload-url`, `PUT website/logo {key|null}` (sin SVG), `PUT website/footer` (enlaces solo `/ruta`, `#ancla`, `https://`, `mailto:` o `tel:`; redes solo `https://`); `GET/PUT contact`, `GET contact/messages` (100 últimos) y `POST contact/messages/:id/handled {handled}`.

- **Demo y calculadora** (`POST /platform-contact {kind}`): `kind` `contact` (por defecto; necesita el formulario activo y un mensaje de 10 caracteres), `demo` (sin mensaje) o `calculator` (con `calculator: {units, avgPrice, occupancyPct, rent, utilities, staff, other, investment}`; el servidor recalcula y manda el informe al visitante). Demo y calculadora se aceptan con el formulario apagado; las tres entran en Leads con su origen (`web_contact`, `demo`, `calculator`).
- **Testimonios**: `PUT /admin/platform/website/home` admite `testimonials` (hasta 6: `quote` 10-600, `name` 2-80, `role`, `business`); `GET /platform-website` los devuelve en `home.testimonials`.

### Blog de TrasterOS (2026-11-12)

- Públicos: `GET /platform-blog` (publicadas, más recientes primero) y `GET /platform-blog/:slug` (con `contentMarkdown`, `seoTitle`, `seoDescription`, `readingMinutes` y 3 `related`; 404 `post_not_found` si no existe o no está publicada).
- Admin (`/admin/platform/blog`; leer también el rol soporte, escribir solo superadmin): `GET`, `GET :id`, `POST` (dirección del título si no se da; `-2`, `-3`… si se repite), `PATCH :id` (la fecha de publicación se fija la primera vez que se publica), `DELETE :id`, `POST :id/cover-upload-url {mimeType, sizeBytes, fileName?}` → `{uploadUrl, key, expiresIn, requiredHeaders}` y `PUT :id/cover {coverImageKey|null}` (solo claves `platform/blog/<id>/…`, imagen real; borra la anterior).

### Web del tenant (#663–#667)

- Plantillas nuevas de Web Premium: `trstrom` y `cabe` (`PATCH /settings/tenant/web {template}`).
- **Dominio propio**: la reserva es `https://<dominio>/reservar[/<publicSlug del local>][/l/<idioma>]` (`resolveCustomDomainRoute` la reescribe a `/book/<slug>`); `/precios` y `/contacto` muestran la web única bajando a esa sección (404 fuera del dominio propio). Un local no puede llamarse `precios`, `contacto` ni `reservar`.
- `PATCH /settings/tenant/web {seo}` (`web_premium`): `homeTitle`, `homeDescription`, `pricesTitle`, `pricesDescription`, `contactTitle`, `contactDescription` (`''` = el generado); `WebSettingsResponse.seo` y `PublicLandingDto.webSeo`.
- **Fotos de la portada de la web** (Web Premium, `settings:manage`): `POST /settings/tenant/web/hero-image-upload-url {slot: image|background, mimeType: image/jpeg|image/png|image/webp}` → URL firmada al bucket público (`<tenant>/web-hero/<slot>-…`) y `PUT /settings/tenant/web/hero-image {slot, key|null}` (se comprueban los bytes reales, máx. 5 MB, sin SVG; la clave tiene que ser del tenant y de ese hueco → 400 `invalid_hero_image_key`; la foto anterior se borra; auditado `tenant.web_hero_image_set`/`_removed`). `WebSettingsResponse.heroImageUrl/heroBackgroundUrl` y `PublicLandingDto.webHeroImageUrl/webHeroBackgroundUrl` (null sin Web Premium). `image` = la entrada del local (a la derecha del titular) y `background` = el interior (difuminado de fondo); hoy las usa la plantilla Cabe.
- **Favicon de la web del tenant** (todos los planes): `POST /settings/tenant/branding/favicon-upload-url {mimeType: image/png|image/x-icon}` → URL firmada al bucket público (`<tenant>/favicon/…`) y `PUT /settings/tenant/branding/favicon {key|null}` (`settings:manage`; se comprueban los bytes reales, máx. 512 KB, sin SVG; 400 `invalid_favicon_key`; auditado). `TenantBrandingResponse.faviconUrl` y `PublicTenantBrandDto.faviconUrl`.
- **Logo del tenant subido** (todos los planes): `POST /settings/tenant/branding/logo-upload-url {mimeType: image/png|image/jpeg}` → URL firmada al bucket público (`<tenant>/logo/…`) y `PUT /settings/tenant/branding/logo {key|null}` (`settings:manage`; bytes reales comprobados, máx. 2 MB, sin SVG ni WebP; 400 `invalid_logo_key`; auditado). Guarda la clave (`tenants.portal_logo_key`) y su URL en `portalLogoUrl`, que siguen leyendo la web, el portal y los correos. Pegar otra dirección en `PATCH /settings/tenant/branding` quita el logo subido (enviar la misma URL no lo toca). `TenantBrandingResponse.logoUploaded`.
- **Icono de la app del inquilino con el logo**: `GET /public/landing/brand/:slug/logo` (público, 60/min) sirve los bytes del logo **subido** (404 sin él; una dirección pegada nunca se descarga desde el servidor). `PublicTenantBrandDto.logoUploaded`. La ruta del icono de la app (`/portal/app/<slug>/icon/<tamaño>`) dibuja ese logo sobre blanco (en `maskable`, dentro del 80 % central) y, sin logo subido, las iniciales sobre el color de marca; lleva `?v=` para que el móvil no se quede con el icono anterior al cambiar el logo.
- **Panel con tu marca** (función `branded_panel`, planes Pro y Administrador): `MeResponse.tenant` lleva `brandColor`, `logoUrl` y `logoUploaded`; con la función, el menú del panel muestra el logo del tenant y el panel se instala con `/panel-app/<slug>/manifest` (nombre «<tenant> · Panel», mismos iconos que la app del portal).

### Mensajería: avisos de los tickets de soporte

- Respuesta visible del admin (`POST /admin/support/tickets/:id/messages` sin `isInternal`) y paso a `resolved`/`closed` → notificación del panel del tenant `support.reply` (también push al equipo) + correo a quien abrió el ticket (`kind: admin_message`, con el texto y el enlace). Las notas internas no avisan.
- Respuesta del tenant → aviso al feed del super admin (`support_ticket`, también push). Responder en un ticket `resolved` lo reabre (`open`); la pantalla del tenant deja responder hasta que se cierra.
- Asignar un ticket avisa en el feed del admin (`support_ticket.assigned`).

### SEPA: mandato firmado por el inquilino

Contrato de adeudos del banco (cláusulas 4.1 y 4.3): no se puede cobrar sin la orden de domiciliación firmada por el deudor, con referencia, datos y domicilio de acreedor y deudor, IBAN, tipo de pago, lugar y fecha y firma, y hay que conservarla.

- `PUT /sepa/settings` acepta `creditorAddress`, `creditorPostalCode`, `creditorCity`, `creditorCountry` (salen en el mandato; sin domicilio, 400 `sepa_creditor_address_required` al pedir una firma).
- `POST /sepa/mandates {customerId, iban, bic?, signedOutside?, signedAt?}`: por defecto el mandato queda **`pending`** y se envía al inquilino un enlace (30 días) para firmarlo; `signingUrl` en la respuesta. Con `signedOutside: true` (firmado en papel, lo guarda el tenant) exige `signedAt` y queda `external`. Los mandatos importados y los que ya existían son `external`.
- `POST /sepa/mandates/:id/signing-link` reenvía el enlace; `GET /sepa/mandates/:id/document` descarga el PDF del mandato firmado con su constancia.
- Público: `GET /public/sepa-mandates/:token` (el mandato con los campos del banco e IBAN enmascarado) y `POST /public/sepa-mandates/:token/sign {signerName, address, postalCode, city, country, place, method: drawn|typed, signatureImage|typedSignature, accept: true}`. Guarda el texto firmado (IBAN enmascarado), la huella SHA-256 (con el IBAN completo), la firma, la IP, el navegador y la hora; el enlace se gasta.
- **Solo los mandatos `signed` o `external` entran en la remesa**; los `pending` salen en `withoutMandate` con `pendingSignature: true`. `SepaMandateDto.signatureStatus/signedByName/signedAtTimestamp`.

### SEPA de la plataforma: mandato firmado por el tenant y preaviso pactado

- `PUT /admin/platform-sepa/settings` acepta `creditorAddress`, `creditorPostalCode`, `creditorCity`, `creditorCountry` y `prenoticeDays` (5 por defecto, 1-30): salen en el mandato que firma el tenant.
- `GET /settings/saas-billing/sepa-mandate/terms` → `{available, creditor, prenoticeDays, debtor}` (datos fiscales del tenant para rellenar).
- `POST /settings/saas-billing/sepa-mandate {iban, bic?, signerName, address, postalCode, city, country, place, method: drawn|typed, signatureImage|typedSignature, accept: true}`: el tenant firma la orden de domiciliación en su panel; se guardan texto (IBAN enmascarado), huella SHA-256, firma, usuario, IP, navegador y hora. Sin acreedor completo → 400 `platform_sepa_not_available`.
- `GET /settings/saas-billing/sepa-mandate/document` y `GET /admin/tenants/:id/sepa-mandate/document`: PDF del mandato firmado.
- Remesa: la vista previa devuelve `prenoticeDays` y `earliestCollectionDate`; crear con una fecha de cobro anterior → 400 `collection_date_too_soon`. Al crearla, cada tenant recibe un **preaviso por correo** (importe, fecha, cuenta, acreedor, referencia; tipo de correo `sepa_prenotice`) y queda constancia en el adeudo (`prenotice_sent_at`, `prenotice_recipients`). Solo entran mandatos firmados (`signed` o `external`, los anteriores).

### SEPA: fichero conforme al cuaderno AEB 19-14

- El fichero pain.008 (inquilinos y plataforma) identifica al presentador en `InitgPty/Id/OrgId/Othr/Id` con el identificador del acreedor, pasa nombres y conceptos al juego de caracteres SEPA (sin acentos ni ñ; `sepaText`) y los recorta (nombre 70, concepto 140), y limpia los identificadores (`sepaId`: 35, sin espacios ni `//`).
- `POST /sepa/remittances` y `POST /admin/platform-sepa/remittances`: 400 `invalid_collection_date` si la fecha de cobro ya pasó, está a más de un año o no es día hábil TARGET2 (`details.suggestion` = la primera válida). Shared `isSepaBusinessDay`, `nextSepaBusinessDay`, `collectionDateIssue`.

### SEPA: caducidad del mandato y preaviso obligatorio

- `SepaMandateDto`/`PlatformSepaMandateDto`: `status` puede ser `expired`; `lastCollectedAt` (último adeudo presentado) y `expiresOn` (36 meses después, o desde la firma si nunca se usó). Al preparar la remesa, un mandato caducado pasa a `expired` y sus facturas salen en `withoutMandate` con `expiredMandate: true`.
- `POST /sepa/remittances`: con una fecha de cobro anterior a hoy + `prenoticeDays` → 400 `collection_date_too_soon` (antes solo avisaba).

### Adeudos SEPA: revisión del mandato (2026-10-23)

- **Identificador del acreedor** (`PUT /sepa/settings`, `PUT /admin/platform-sepa/settings`): se comprueban sus dígitos de control (ISO 7064 mod 97-10 sobre el NIF + `ES00`; el código de negocio no cuenta) → 400 si no cuadran. Shared `isValidCreditorId`/`normalizeCreditorId`/`creditorIdSchema`. Crear una remesa con un identificador guardado incorrecto → 400 `invalid_creditor_id`.
- **El identificador no se puede cambiar con mandatos firmados** (`signed`/`external` activos) → 409 `creditor_id_locked` (`details.signedMandates`): va impreso en los mandatos y el banco exigiría presentar cada adeudo como modificación. Sí se puede si el anterior era incorrecto.
- **Preaviso por mandato**: cada mandato guarda el plazo pactado al darse de alta o firmarse (`prenoticeDays`); la remesa exige el mayor de sus mandatos (shared `requiredPrenoticeDays`), aunque luego se baje el ajuste. La vista previa (`prenoticeDays`, `earliestCollectionDate`) ya lo tiene en cuenta y `collection_date_too_soon` lleva `details.prenoticeDays`.
- `POST /sepa/mandates` (y la importación): fecha de firma posterior a hoy → 400 `invalid_signed_at` / error de fila. La fecha de firma en la app es la de hoy en hora de España (la misma que dice el documento).
- `GET /sepa/mandates/:id/document` y el PDF del mandato de la plataforma llevan un **anexo para el acreedor** (no forma parte del texto firmado): IBAN completo, a qué email se envió el enlace de firma (inquilinos) o con qué cuenta de usuario se firmó (tenants).
- Plataforma: `POST /admin/platform-sepa/remittances/:id/cancel` (superadmin, auditado; solo `generated`, si no 400 `remittance_not_cancellable`) → los adeudos pasan a `cancelled` y su periodo se puede domiciliar en otra remesa. `POST /admin/platform-sepa/remittances/:id/prenotices/retry` (superadmin; solo `generated`) reenvía los preavisos no enviados → `{sent, failed, noEmail}`. `PlatformSepaRemittanceItemDto` gana `prenoticeStatus` (`sent` | `failed` | `no_email` | null), `prenoticeSentAt`, `prenoticeRecipients`; `itemStatus` puede ser `cancelled`.
- Confirmar una remesa de la plataforma solo pasa a RCUR y fecha el último cobro de los mandatos cuyo adeudo se registró.

### Mensajería: adjuntos en tickets y chat

- Migración `20261109180000_message_attachments` (`attachment_key`/`_mime`/`_name` en `support_ticket_messages` y `customer_messages`). Un adjunto por mensaje: imagen (JPG/PNG/WebP) o PDF, máx. 10 MB, bucket privado `uploads` (`<tenant>/support/…` y `<tenant>/chat/<customer>/…`), bytes comprobados al guardar (400 `invalid_attachment` si la clave no es de esa conversación).
- URL firmada para subir: `POST /support/tickets/attachments/upload-url`, `POST /admin/support/tickets/:id/attachments/upload-url`, `POST /customers/:id/messages/upload-url` (`customers:write`), `POST /portal/me/messages/upload-url` → `{uploadUrl, key, requiredHeaders}`. Luego `attachment: {key, mimeType, filename}` en `POST /support/tickets` (al abrir), `…/messages` y `POST /portal/me/messages`; el texto puede ir vacío si hay adjunto.
- Los DTO de mensaje llevan `attachment: {url, mimeType, filename} | null` (URL firmada 10 min; los PDF se descargan). Anonimizar un inquilino borra también los adjuntos de su chat.

### Mensajería: mensajes de TrasterOS en el panel del tenant

- Migración `20261109160000_tenant_platform_messages` (RLS): todo lo que el super admin envía a un tenant queda también en su panel, **Soporte → «Mensajes de TrasterOS»** (`GET /support/platform-messages`, del tenant del JWT; `kind` `direct` | `announcement` | `retention`), con notificación `platform.message`.
- **Correo directo** (`POST /admin/tenants/:id/email`): además abre un **ticket** (`category: trasteros`, `waiting_user`, mensaje del admin) para responder desde el panel; el correo lleva el enlace «Puedes responder desde tu panel». Anuncios (`/admin/announcements`) y playbook de retención se guardan sin ticket; el anuncio lleva al pie el enlace a Soporte.

### Mensajería: avisos del chat inquilino ↔ equipo

- El equipo escribe en «Mensajes» → push al inquilino (abre `/portal/consume?tab=mensajes`) y **copia por correo** (`customer_email.staff_message`, tipo `staff_message` en Ajustes → Correo, activado por defecto), como mucho una cada 15 minutos por inquilino.
- El inquilino escribe (portal, WhatsApp o email entrante) → notificación `customer.message` (enlace `/customers/:id?tab=chat`) y aviso por correo al equipo (tipo `customer_message`, en Ajustes → Correo y en las preferencias de cada usuario). **Solo el primero mientras tenga mensajes sin leer**: varias frases seguidas no generan varios avisos.
- **La respuesta sale por donde escribió el inquilino** (`chatReplyChannel` en shared): si su último mensaje entró por WhatsApp (número de la plataforma) hace menos de 24 h, la respuesta del equipo sale también por WhatsApp (`communications` con `source: customer_message.reply`); si entró por email, cada respuesta sale por email aunque las copias estén apagadas. La pestaña del chat indica por dónde le llegará.
- `GET /whatsapp/conversations?customerId=` (conversaciones del WhatsApp del negocio con ese inquilino): la ficha enlaza su conversación (`/whatsapp?c=<id>`) con los no leídos.
- **Bandeja «Mensajes»** (`/messages`, menú Operativa, con el contador de no leídos): `GET /customer-messages/conversations?facilityId=` (`customers:read`) → conversaciones por último mensaje con los no leídos **de quien mira** (máx. 200; con locales asignados o filtro, solo inquilinos con contrato en ellos). `GET /customer-messages/unread-summary` pasa a ser **por usuario**: abrir el chat (`GET /customers/:id/messages`) solo apaga los pendientes de quien lo abre (`customer_message_reads`). Las conversaciones del WhatsApp del negocio con no leídos se enlazan arriba.
- Eventos internos `domain.customer_message_from_staff` / `domain.customer_message_from_customer` (no son disparadores de automatizaciones).

### WhatsApp Business (#668–#673)

Todo con la feature `whatsapp_business`. WhatsApp simulado con `NODE_ENV=test` o `WHATSAPP_BUSINESS_MODE=stub`.

- **Número** (`/settings/whatsapp`): `GET` (`settings:read`; incluye `webhookUrl`, `webhookVerifyToken` y `appSecretConfigured`), `PUT {phoneNumberId, wabaId?, accessToken?, enabled?, webButtonEnabled?, appSecret?}` (`settings:manage`; al activar se comprueba contra Meta → 400 `whatsapp_connection_failed`; 409 `whatsapp_number_taken`), `POST /test`. El token nunca vuelve (solo sus 4 últimos).
- **Asistente** (`/settings/whatsapp/assistant`): `GET`, `PUT {assistantEnabled, assistantInstructions, assistantBookingsEnabled, reminderTemplateName, reminderTemplateLanguage, privacyUrl (https), ownProvider, ownModel, ownBaseUrl, ownApiKey, removeOwnKey}`, `POST /test` (prueba la clave propia).
- **Bandeja** (`/whatsapp/conversations`, leer `communications:read`, enviar `communications:send`): `GET` (200 últimas), `GET /unread-count`, `GET /stats?days=` (conversaciones, mensajes, respuestas del asistente y del equipo, pasos a persona, reservas y firmadas, mediana de primera respuesta), `GET /templates` → `{wabaConfigured, templates[{name, language, category, body, paramCount}], error}` (aprobadas en Meta; necesita `wabaId`), `GET /:id` (marca leída; los archivos con URL firmada de 10 min), `PATCH /:id {assistantEnabled}`, `POST /:id/messages {body}` (400 `whatsapp_window_closed` pasadas 24 h; 502 `whatsapp_send_failed`), `POST /:id/template {name, language, params[]}`, `POST /:id/media/upload-url {mimeType, filename, size}` (JPG/PNG ≤5 MB, PDF ≤20 MB) y `POST /:id/media {key, mimeType, filename, caption?}` (400 `invalid_media_key`, `invalid_file_content`, `file_too_large`).
- **Webhook** `GET/POST /webhooks/whatsapp`: la verificación acepta `WHATSAPP_VERIFY_TOKEN` o el token propio de un tenant; la firma `X-Hub-Signature-256`, la de `WHATSAPP_APP_SECRET` o la del secreto de la app propia del tenant dueño de **todos** los números del aviso. Si `metadata.phone_number_id` es de un tenant va a su bandeja (aunque tenga el extra suspendido o el número desactivado: se guarda sin avisos ni asistente); si no, al flujo del número de la plataforma. Guarda texto, archivos, ubicaciones y respuestas a botones; ignora reacciones. Si no se puede guardar un mensaje → 500 (Meta reenvía; los ya guardados se descartan por su id).
- **Asistente IA de la plataforma** (super admin): `GET/PUT /admin/ai-settings {apiKey?, model?, monthlyQueryLimit?, dailyUserLimit?, portalDailyLimit?}` (`apiKey: ''` quita la del panel y vuelve a las variables de entorno; la clave nunca se devuelve, solo sus 4 últimos caracteres y de dónde sale: `panel`/`env`/`demo`) + `POST /admin/ai-settings/test`; por tenant `GET/PUT /admin/tenants/:id/ai-usage {monthlyLimit: number|null}` (escribir: rol superadmin, auditado).
- **Consumo del asistente** (tenant): `GET /ai/usage` → `AiUsageDto` (`used`, `limit`, `extra`, `customLimit`, `dailyUsed`, `dailyLimit`, `resetsOn`). El chat, el streaming, sugerir respuesta, borradores de campaña y de páginas de zona y el chatbot del portal responden **429 `ai_monthly_limit_reached`** al gastar las consultas del mes y **429 `ai_daily_limit_reached`** al pasar el tope diario por persona. El chatbot del área de clientes (`POST /portal/me/ai-chat`) responde 429 `ai_daily_limit_reached` al pasar el tope diario por inquilino. Contratar un extra de consultas sin el asistente → 400 `addon_requires_ai_assistant`. **Clave propia** (`settings:manage`): `GET/PUT /ai/settings {apiKey?, model?}` (nunca devuelve la clave; `''` la quita) y `POST /ai/settings/test`. `PUT /admin/tenants/:id/ai-usage` acepta también `mode` (`platform`|`own`); en `own` sin clave → 503 `ai_own_key_missing`. `GET /ai/usage` añade `mode`, `ownKeyConfigured` y `ownQueries`. `GET /admin/usage` añade por tenant `ai.queriesThisMonth`/`queryLimit`/`revenueMonthly` y `totals.aiRevenueMonthly`; `GET /admin/finance` añade `ai`. `GET /admin/tenants/:id/reset-preview` añade `files` (por tipo: ficheros y bytes).
- **IA de WhatsApp de la plataforma** (super admin): `GET/PUT /admin/whatsapp-ai` + `POST /admin/whatsapp-ai/test`; por tenant `GET/PUT /admin/tenants/:id/whatsapp-ai {aiMode, aiMonthlyLimit}` (escribir: rol superadmin, auditado).
- **Legal**: slug `data-deletion` en `/platform-legal/:slug` y `/admin/platform/legal/:slug` (página pública `/eliminar-datos`).

### Cobro con tarjeta con Stripe Connect (PR 1 de 4)

El tenant conecta su propia cuenta de Stripe (Express) y elige con qué cobra la tarjeta a sus inquilinos. Stripe simulado con `NODE_ENV=test` o `STRIPE_CONNECT_MODE=stub`.

- `GET /settings/stripe-connect` (`settings:read`) → `StripeConnectStatusDto` (`platformAvailable`, `connected`, `accountId`, `chargesEnabled`, `payoutsEnabled`, `detailsSubmitted`, `requirementsDue`, `applicationFeePct`, `cardProvider`, `effectiveCardProvider`, `redsysEnabled`).
- `billing:configure`: `POST /settings/stripe-connect/onboarding-link` (crea la cuenta si no existe → `{url}` del registro de Stripe; vuelve a `/settings/payments?stripe=return`), `POST …/refresh` (lee el estado en Stripe; 404 `stripe_not_connected`), `POST …/dashboard-link` (panel Express; 400 `stripe_onboarding_incomplete`), `DELETE` (desconecta; si la tarjeta iba por Stripe vuelve a Redsys o a nada) y `PUT …/card-provider {provider: 'redsys'|'stripe'|null}` (400 `stripe_not_ready` / `redsys_not_enabled`). Sin clave real de Stripe → 503 `stripe_not_configured`.
- Super admin: `GET/PUT /admin/payment-settings {applicationFeePct}` (0-10 %, por defecto 2; escribir: superadmin, auditado) → incluye `connectedTenants`.

**PR 2 — cobros en la cuenta del tenant.** Con la tarjeta por Stripe y la cuenta lista (`cardContext` = `connect`), `POST /payment-methods/setup-intent` y `/portal/me/payment-methods/setup-intent` crean el cliente y el SetupIntent (solo tarjeta) **en la cuenta del tenant** y devuelven `stripeAccount` (`SetupIntentResponseDto.stripeAccount`; la web abre Stripe.js con él). Los métodos guardados llevan `payment_methods.stripe_account_id`; cobrar una tarjeta de otra cuenta → 400 `stripe_account_changed`. El cobro (`chargeInvoice`, también el automático y los reintentos) se hace en la cuenta del tenant con `application_fee_amount` = comisión de la plataforma (`payments.stripe_account_id`, `payments.application_fee_amount`) y clave de idempotencia `charge-<paymentId>`; el reembolso va a esa cuenta con `refund_application_fee`. `GET /payment-methods/options` y `/portal/me/payments/options` miran el tenant. `GET /portal/me/redsys/enabled` gana `cardEnabled` (false si la tarjeta va por Stripe: Redsys queda para Bizum).

**PR 3 — webhook de las cuentas conectadas.** `POST /webhooks/stripe-connect` (endpoint «Connect» de Stripe, firma con `STRIPE_CONNECT_WEBHOOK_SECRET`; deduplicado con los demás eventos de Stripe). El tenant sale de `event.account`, no de los metadatos: `payment_intent.succeeded`/`payment_failed`, `charge.refunded`, `charge.dispute.created` (mismo tratamiento que los cobros de siempre), `account.updated` (estado de la cuenta) y `account.application.deauthorized` (se olvida la cuenta y la tarjeta vuelve a Redsys o a nada). Eventos de una cuenta sin tenant se ignoran.

**PR 4 — Redsys con pago por referencia.** `PUT /settings/redsys {cardOnFileEnabled}` (lo tiene que activar el banco en el TPV). Con él activo, `GET /portal/me/redsys/enabled` devuelve `cardOnFileEnabled: true` y `POST /portal/me/invoices/:id/redsys-redirect {payMethod: 'card', saveCard: true}` pide a Redsys guardar la tarjeta (`DS_MERCHANT_IDENTIFIER=REQUIRED`, `COF_INI=S`, `COF_TYPE=R`). Al confirmarse el pago, la notificación trae la referencia y se guarda como método de pago por defecto (`gateway: 'redsys'`, `payment_methods.network_txn_id` = `Ds_Merchant_Cof_Txnid`; sustituye a la tarjeta de Redsys anterior). `chargeInvoice` (también el cobro automático al emitir y los reintentos) cobra esa tarjeta por la API REST de Redsys (`trataPeticionREST`, `EXCEP_SCA=MIT`, `COF_INI=N`): autorizado → pagada; denegado → pago fallido (aviso al inquilino y dunning como siempre). Simulado con `NODE_ENV=test` o `REDSYS_MODE=stub`.

### Portal del inquilino: revisión (2026-10-17)

- `POST /portal/me/password` acepta `currentPassword`: obligatoria si el inquilino ya tiene contraseña (400 `current_password_invalid` si falta o no coincide). La primera contraseña no la pide.
- Toda llamada `/portal/me/*` responde **401 `account_unavailable`** si el negocio está suspendido, dado de baja o borrado (antes solo pagos y contrataciones daban 403). El enlace de acceso y el de restablecer contraseña no se envían a un negocio así.
- `GET /portal/me/invoices`: `amountPending` descuenta la retención de IRPF (era el total). `GET /portal/me/payments` ya no lista la retención ni los abonos compensados.
- `AvailableUnitDto.taxRate` y `PortalWaitlistDto.options[].unitTypes[].taxRate`: IVA del alquiler (21 % trastero, 0 % vivienda).
- `POST /portal/me/unit-requests`: 404 si `facilityId`/`unitTypeId` no son del negocio.
- Evento interno `domain.contract_move_out_cancelled` (anular la baja en el portal o aceptar una oferta de retención con la baja en curso) → notificación `contract.move_out_cancelled` al equipo.

### Panel del tenant: alcance por local y filtro de la cabecera (2026-10-18)

- `facilityId` (local elegido en el selector de la cabecera) en `GET /invoices`, `/payments`, `/collections`, `/contracts/renewals`, `/access/logs` (local del dispositivo), `/maintenance-plans`, `/unit-requests`, `/unit-change-requests` y `/calendar` (ya existía en tareas, incidencias, gastos, reservas y contratos). Un local fuera de los del usuario devuelve una lista vacía.
- Respetan los locales del usuario (`facilityScope`): búsqueda global (contratos, trasteros y facturas; los inquilinos son de toda la empresa), calendario, `/dashboard/today`, `/dunning`, tareas, incidencias, gastos, mantenimiento y solicitudes/cambios de trastero. En lo que puede no tener local (tareas, incidencias, gastos, mantenimiento, solicitudes), sin local elegido se incluye lo de toda la empresa.
- Permisos que faltaban: `/search` `customers:read`, `/calendar` `tasks:read`, `/dashboard/today` `contracts:read`, `/dashboard/onboarding` `settings:read`, `/dashboard/occupancy` `units:read`, `/dunning` `invoices:read` (los cuatro roles base ya los tienen).

### Listas paginadas del panel (2026-10-18)

`GET /customers/page`, `/contracts/page`, `/invoices/page`, `/payments/page`, `/leads/page`, `/tasks/page`, `/incidents/page` y `/expenses/page` → `PageDto<T>` `{ items, nextCursor }`, por cursor (`?cursor=<id de la última fila>&limit=` 1-100, 50 por defecto; 400 `invalid_cursor` si no es un id). Aceptan los mismos filtros que su lista y `search` (inquilinos: nombre, email, teléfono o documento, **por palabras**; contratos: número, inquilino o trastero; facturas y pagos: número de factura o inquilino; contactos: nombre, email o teléfono; tareas e incidencias: título; gastos: descripción o proveedor). Las listas sin `/page` se mantienen para las fichas (filtradas por inquilino, contrato…).

### Oportunidades sobre los inquilinos

- `POST /portal/me/interest {kind, unitTypeId?}` (sesión del área de clientes, 204, silencioso): el inquilino ha mirado el seguro, otro trastero, uno mayor o el pase nocturno sin contratarlo; una señal por hora y tipo (`customer_interest_events`, RLS).
- `GET /opportunities` (`customers:read`, alcance por local): por inquilino con contrato activo, qué ofrecer — seguro (contratos sin protección; más fuerte si miró el seguro), trastero mayor (lo miró o pidió cambio y hay uno libre más grande en su local), otro trastero (lo miró en 30 días), pase nocturno (intentos de entrar fuera de horario o lo miró; solo con el pase activo) y domiciliar el pago (sin tarjeta, adeudo ni mandato) — con motivo, oferta con precio con IVA, valor mensual y última propuesta (lo propuesto en 30 días baja en el orden).
- `GET /opportunities/draft?customerId=&kind=` (404 `opportunity_not_found` si ya no aplica): asunto, texto del correo y texto para WhatsApp con el enlace al área de clientes.
- `POST /opportunities/propose {customerId, kind, subject?, body?, followupInDays}` (`communications:send`): envía el correo (Comunicaciones, `source: opportunity:<kind>`), crea el seguimiento y audita `opportunity.proposed`. Solo propone: no cambia el contrato.

### «Hoy»: cifras del mes y actividad

- `GET /dashboard/today/summary?facilityId=` (`contracts:read`, alcance por local; 400 `invalid_facility_id`): cifras del mes en hora de España — facturado, cobrado (cobros reales), deuda vencida pendiente, ocupación, trasteros libres y totales, altas (contratos firmados) y bajas (contratos terminados) — y la actividad de las últimas 48 h (contratos firmados, cobros recibidos y rechazados, bajas pedidas, contactos nuevos, mensajes de inquilinos e incidencias), cada una con su enlace.

### Presupuesto a un contacto

- `POST /leads/:id/quote/preview {facilityId, unitTypeId, months 1|3|6|12, couponCode?, insurancePlanId?}` (`leads:read`, 200): lo que pagaría al reservar (el trastero libre más barato de ese tamaño en ese local, con el cupón como un cliente nuevo, el seguro de los mismos meses y la fianza), la cuota mensual con IVA después, el enlace a la reserva online con el local, el tamaño, los meses y el cupón ya puestos (`utm_source=presupuesto`) y el correo redactado. 409 `no_units_available`, 400 `insurance_plan_not_found`.
- `POST /leads/:id/quote/send` (mismo cuerpo + `subject?`, `body?`; `communications:send`): envía el correo (Comunicaciones, `source: lead.quote`), guarda el local y el tamaño que busca, pasa el contacto de «nuevo» a «contactado» y audita `lead.quote_sent`. 400 `lead_without_email`. Si reserva con ese email, la reserva marca el contacto como ganado con el origen del enlace.

### Extras por inquilino

- `GET /customers/extras` (`customers:read`, alcance por local): inquilinos con contrato activo y qué tiene cada uno — protección de contenido (contratos con seguro / total), cobro automático (tarjeta, adeudo o mandato SEPA), accesos adicionales activos, pases nocturnos de los últimos 90 días, compras en la tienda de los últimos 12 meses y si entra al área de clientes con contraseña — más cuántos inquilinos tienen cada extra. En la web, «Extras» en Inquilinos: al pulsar un extra se ven los que no lo tienen.

### Portal: mi cuenta

- `GET /portal/me/account` (sesión de portal): lo que paga al mes con IVA (por contrato: alquiler con descuento + seguro), cómo se le cobra (`payVia` card | sepa_debit | sepa_mandate | null, marca y últimas cifras), si se cobra solo (`automatic`) y si puede domiciliar desde el portal (`canSetupAutomatic`), el próximo cargo, lo que ya se está cobrando (`inProgress`: adeudo en curso o en remesa SEPA), lo emitido sin vencer y, si debe algo, `overdue` con importe, desde cuándo, los pasos del escalado de la factura más antigua (`steps`: recordatorios, recargo, corte de acceso, reclamación, con fecha y si ya ocurrió) y `accessBlocked`.
- `GET /portal/me/invoices`: `paymentInProgress` también es `true` con la factura en una remesa SEPA sin confirmar.
- `GET /portal/me/contracts`: `effectivePriceWithVat` e `insurancePriceWithVat` (la cuota y el seguro con IVA).
- `GET /portal/me/invoices` gana `unitCode`, `periodStart`/`periodEnd`, `lateFeeForNumber` (es un recargo de esa factura), `lines` (concepto e importe con IVA de cada línea) y `lastFailure` (último cobro rechazado con el motivo en palabras del inquilino, solo mientras siga pendiente y sin otro cobro en marcha).
- `GET /portal/me/access` devuelve también los accesos suspendidos con `suspension` (`unpaid`, la factura que lo provocó y lo que falta por pagar); mientras está suspendido `value` va a null.

### Portal: ofertas para el inquilino

- `POST /opportunities/propose` crea además una propuesta (`customer_offers`, 30 días; sustituye a la anterior del mismo tipo) que sale en el área de clientes. `GET /opportunities` gana `lastOfferStatus` (open · interested · declined · accepted · expired).
- `GET /portal/me/offers` (sesión de portal): propuestas vivas; antes marca como aceptadas las que ya contrató (seguro puesto, contrato nuevo, pase nocturno comprado o pago domiciliado después de la propuesta) y como vistas las nuevas.
- `POST /portal/me/offers/:id/respond {response: interested|declined}` (200, devuelve la lista): «Me interesa» avisa al equipo (notificación `customer.offer_interested`). 400 `invalid_response`, 404 `offer_not_found`.

### Uso del portal en el panel

- `customers.portal_last_seen_at`: última visita del inquilino a su área de clientes (se anota al validar la sesión del portal, como mucho una vez por hora y sin tocar `updated_at`). `GET /customers/overview` la devuelve como `portalLastSeenAt`.
- `GET /dashboard/today/summary`: `kpis.debtorsWithoutPortal` (inquilinos con facturas vencidas que nunca han entrado).

### Portal: avisos y métodos de pago

- `GET /portal/me/notices`: los 30 últimos correos que el negocio le ha enviado (enviados o entregados, con asunto); los datos secretos (p. ej. un PIN) salen como `••••`.
- `DELETE /portal/me/payment-methods/:id` y `POST /portal/me/payment-methods/:id/default` (200, devuelven la lista): quitar un método de pago (si era el predeterminado, pasa a serlo el más reciente) o elegir con cuál se cobra. 404 si no es suyo.
- `GET /portal/me/insurance-plans` devuelve `[]` si el plan del negocio ya no incluye la protección.

### Push del super admin

- `GET /admin/me/push?endpoint=` → `{publicKey, subscribed}`, `POST /admin/me/push/subscribe {endpoint, keys}` y `POST /admin/me/push/unsubscribe {endpoint}` (204; `AdminGuard`, también el rol soporte). Suscripciones en la tabla global `super_admin_push_subscriptions` (sin tenant; REVOKE para `storageos_app`).
- Los avisos salen del feed `super_admin_notifications`: la tarea `super-admin-push.send` (cada minuto, en el worker) reclama de forma atómica los de la última hora aún sin enviar (`pushed_at`) y manda los tipos de `SUPER_ADMIN_PUSH_TYPES` (tickets, aprobaciones, formulario de la web, contracargos, suscripción de Stripe terminada o sin tenant, correo rechazado por el proveedor, interés repetido en una función) a cada super admin activo con el push activado. Con 4 o más a la vez, un solo aviso con el recuento. Sin claves VAPID no hace nada.

### Portal: sesión de la app instalada

- `POST /portal/login/consume`, `/portal/login/password`, `/portal/login/reset` y `/portal/me/password` aceptan `installedApp?: boolean`. Con `true` (el portal abierto como app instalada, `display-mode: standalone`) la sesión dura **30 días** (`PORTAL_APP_SESSION_DAYS`); sin él, 48 h como hasta ahora. `expiresIn` lo refleja.
- `POST /portal/me/session/renew {installedApp?}` (sesión de portal, 200 → `PortalSessionDto`): sesión nueva con la que ya se tiene. La app instalada la pide al abrirse, así que solo caduca tras un mes sin usarla. Se corta igual que el resto: cambiar la contraseña, «Cerrar sesiones del portal» (401) o negocio suspendido (403 `account_unavailable`).

### Contratos: texto firmado, firma y borradores (2026-10-23)

- **Texto que firma el inquilino** (`composeContractTerms`, el mismo en la vista de firma, al firmar y en el PDF): arrendador (razón social, NIF y domicilio fiscal del negocio, o el propietario del local con «Gestionado por»), inquilino con su documento y domicilio, trastero con tipo y m², inicio y duración, preaviso de baja, cuota con su IVA (o exenta en vivienda), descuento, promoción, primer pago o prepago, cupón, protección de contenido, fianza, cláusulas y consentimiento eIDAS. Sin cláusulas propias se usan las **condiciones generales** (`DEFAULT_STORAGE_CLAUSES` en shared; antes el texto firmado no llevaba ninguna y el PDF ponía otras).
- `GET /public/move-in/sign/:token` gana `termsHash` (SHA-256 del texto), `signedAt` y `paymentPending`. `POST /public/move-in/sign/:token` acepta `termsHash`: si el contrato cambió desde que se abrió el enlace → 409 `terms_changed`.
- El enlace de firma **sigue valiendo tras firmar** (hasta su caducidad): muestra «ya firmado» y el texto firmado. `POST /public/move-in/sign/:token/payment` (200 → `{portalToken}`, 10/min) da una sesión de portal para pagar la 1ª factura si aún está pendiente; si no, 409 `nothing_to_pay`. La firma repetida solo devuelve `portalToken` con algo por pagar.
- **Anexos** (contrato firmado): `GET /contracts/:id/annexes` (`contracts:read`) → `ContractAnnexDto[]`; `POST /contracts/:id/annexes {title, body}` (`contracts:write`; 409 `contract_not_signed` si no está activo o en baja) → `ContractAnnexSentDto {annex, signingUrl, emailed}`; `POST …/annexes/:annexId/resend` y `…/cancel` (409 `annex_not_pending`); `GET …/annexes/:annexId/pdf` → `{url}` (409 `annex_not_signed`). Públicos: `GET /public/annexes/sign/:token` → `AnnexSignViewDto` y `POST /public/annexes/sign/:token {signerName, method, signatureImage|typedSignature, accept, documentHash}` (409 `annex_changed`/`annex_already_signed`; 401 `annex_link_invalid`/`annex_link_expired`/`annex_cancelled`). Área de clientes: `GET /portal/me/annexes` → `PortalAnnexDto[]` (pendientes y firmados), `POST /portal/me/annexes/:id/sign-link` → `{token}` y `GET /portal/me/annexes/:id/pdf`.
- `POST /contracts` y `PATCH /contracts/:id` admiten `specificConditions` (texto, máx. 5.000; `''` las quita): las condiciones propias del contrato, que van en el texto que se firma tras las generales. Solo en borrador: con el contrato firmado, 400 `contract_not_draft`. `ContractDto.specificConditions`.
- `GET /contracts/:id/signing` (`contracts:read`, alcance por local) → `ContractSigningRecordDto`: texto firmado (o el que verá el inquilino en borrador), `termsFrozen`, `termsHash`, firmas con `signatureImage`/`typedSignature`/`documentHash`/`userAgent`/`hashMatches`, `signingLinkActive`/`signingLinkExpiresAt` y `holdUntil` (reserva online). `GET /contracts/:id/signatures` y `POST /contracts/:id/request-signature` comprueban ahora el alcance por local.
- `PATCH /contracts/:id` acepta en **borrador** `priceMonthly`, `startDate` y `depositAmount` (400 `contract_not_draft` si ya está firmado; `coupon_price_locked` si lleva cupón y cambia la cuota) y `endDate: ''` para quitar la fecha de fin; 400 `invalid_end_date` si el fin queda antes del inicio.
- **PDF del contrato**: se genera solo al firmar (`contract_signed`) con el texto congelado, la firma (imagen o nombre), firmante, email, fecha y hora, canal, IP, navegador, huella y la comprobación de que la huella coincide con el texto. «Generar PDF» lo regenera; en borrador lleva el aviso de pendiente de firma.
- Reserva online de un inquilino nuevo: además de seguir en pantalla, recibe el enlace de firma por correo (`source: booking.signing_link`).
- 🐛 Los PDF del API (facturas, contratos, mandatos SEPA, facturas de la suscripción, requerimientos) no se generaban con Node 20: Puppeteer se carga ahora con `loadPuppeteer()` (`common/puppeteer.ts`).

### «Hoy» y Resumen (2026-10-26)

- `GET /dashboard/today` usa el día de calendario del tenant; `unreadMessages` es por usuario; `signaturesPending` solo borradores; `contractsEndingSoon` y `moveOutsToday` sin los activos con renovación automática; `invoicesOverdue` incluye las emitidas con el vencimiento pasado.
- `GET /dashboard/today?mine=1`: tareas e incidencias asignadas al usuario, contactos asignados a él y seguimientos que creó.
- `invoicesDueToday.items` e `invoicesOverdue.items` (hasta 8): `TodayItemDto` con `amount` (pendiente) y `chargeable` (tiene tarjeta o domiciliación guardada).
- `GET /dashboard/today/summary`: `kpis.previous` (facturado, cobrado, altas y bajas del mes anterior hasta el mismo día), `kpis.targetOccupancyPct` (estrategia de precios) y `kpis.unitsToTarget`.
- `POST /dashboard/today/daily-summary/test` (`contracts:read`) → `{ sent }`: envía ahora el resumen del día al usuario.
- Aviso por correo nuevo `daily_summary` en `/me/email-notices` y `/settings/tenant/staff-emails` (por usuario, apagado por defecto).

### Revisión de Configuración (2026-10-28)

- `GET/PATCH /settings/tenant/profile` (`settings:read` / `settings:manage`, auditado `tenant.profile_changed`): `{name, timezone}` del negocio; zona IANA no válida → 400.
- Invitaciones: las caducadas ya no cuentan en el límite de usuarios ni bloquean volver a invitar (la caducada queda revocada con motivo `expired`).
- Propietario: `PATCH /settings/users/:id/tenant-role` y `…/facilities` sobre el propietario → 400 `owner_full_access`; el propietario resuelve siempre todos los permisos y todos los locales, y al transferir la propiedad el nuevo propietario pierde su rol a medida y sus locales.
- `PATCH /invoice-series/:id`: 409 `series_in_use` al cambiar prefijo o numeración de una serie con facturas emitidas, 409 `default_series_required` al desactivar o quitar la serie por defecto, 409 `inactive_series_not_default` al marcar por defecto una desactivada.
- Webhooks: el evento de factura emitida se llama `invoice.issued`; los webhooks suscritos al antiguo `invoice.created` lo siguen recibiendo con ese nombre (no se duplica si están suscritos a los dos).

### Funcionalidades de Configuración (2026-10-28)

- `GET /me/sessions` → sesiones abiertas del usuario (`UserSessionDto`: navegador, IP, última actividad, app instalada, `current`); `DELETE /me/sessions/:id` (404 `session_not_found`) y `POST /me/sessions/revoke-others` → `{revoked}` (la de este navegador sigue abierta).
- Cambio del email de acceso: `GET /me/email-change` → `{pendingEmail, expiresAt}`; `POST /me/email-change {newEmail, currentPassword}` (403 `wrong_current_password`, 400 `same_email`, 409 `email_in_use`) envía un enlace de 24 h al email nuevo y avisa al actual; `DELETE /me/email-change` lo cancela; `POST /email-change/confirm {token}` (público, un solo uso; 400 `email_change_invalid`) cambia el email.
- `PATCH /settings/tenant/profile` acepta `contactPhone` y `contactEmail` (`''` los quita): salen en la web en los locales sin contacto propio.
- `GET /settings/tenant/health` (`settings:read`) → lo que conviene revisar (`ConfigHealthItemDto`: serie por defecto, datos fiscales, certificado AEAT, forma de cobro, dominio y correo sin verificar).
- `POST /settings/tenant/domain/check` (`settings:manage`) → `CustomDomainCheckDto`: si el dominio propio ya apunta a la plataforma, avisa una vez al super admin (`custom_domain.ready`); cron `custom-domains.dns-check` cada hora hace lo mismo con los pendientes. Cambiar o quitar el dominio olvida el aviso.
- `GET /audit-logs` acepta `userId`, `action` (prefijo), `from`, `to` (`YYYY-MM-DD`; 400 `invalid_date`) y `limit` (hasta 500); cada fila trae `changes` e `ipAddress`.
- `GET /rgpd/requests`: `customerName`. `GET /dashboard/today`: `rgpdRequestsDue` (solicitudes sin cerrar que vencen en 7 días).
- Invitaciones: `revokedReason` en el DTO; las no aceptadas caducadas o revocadas hace más de 90 días se borran en el cron de retención.

### Reservas antes de la apertura (2026-10-28)

- `GET /facilities/:id/opening` (`facilities:read`) → `{ preOpening, openingDate, maxMonths, reservations }`.
- `PUT /facilities/:id/opening` (`facilities:manage`) `{ preOpening, openingDate: 'YYYY-MM-DD' | null, maxMonths }` → además `{ moved, started }`. Cambiar o quitar la fecha mueve la fecha de inicio de las reservas y avisa por correo a cada inquilino. Con la fecha de hoy o pasada, o con `preOpening: false`, el local abre: las reservas empiezan (trastero ocupado, acceso al que ya pagó, recurrente desde el mes siguiente).
- Con el local en «próxima apertura», `POST /contracts` (panel, reserva online y portal) crea el contrato como reserva anticipada: primer pago = una mensualidad completa (sin prepago ni meses por adelantado; un cupón descuenta esa mensualidad) + fianza; la primera factura no lleva periodo y vence a los 3 días en la reserva online y a los 15 en el panel. Al firmar, el trastero queda `reserved` y el acceso espera a la apertura.
- `POST /contracts/:id/change-unit` en una reserva sin empezar: solo otro trastero del mismo local y del mismo precio (400 `pre_opening_same_price`), sin `newPrice` ni prorrateo.
- `GET /contracts/:id/pre-opening/cancel-preview` (`contracts:read`) → `{ allowed, reason: withdrawal|not_opened_in_time|standard, refundRent, refundDeposit, withdrawalEndsOn, rentAmount, depositAmount }`; `POST /contracts/:id/cancel-pre-opening {reason?}` (`contracts:manage`): reembolsa la primera mensualidad (o la anula si no se cobró), devuelve la fianza (14 días de desistimiento o plazo vencido sin abrir) o la retiene como arras, cancela el contrato y avisa al equipo. 400 `pre_opening_started` si ya empezó, `not_pre_opening` si no es una reserva anticipada.
- Portal: `GET/POST /portal/me/contracts/:id/pre-opening-cancel` (lo mismo para el inquilino). `PortalContractDto.preOpening`, `ContractDto.preOpening` y `ContractSignViewDto.preOpening` (`{ dateConfirmed, openingDate, deadline, startedAt }`).
- Web pública: `PublicLandingFacilityDto` y `BookingAvailabilityDto.facilities[]` ganan `preOpening` + `openingDate`; `FirstPaymentQuoteDto.preOpening`.
- **Revisión (2026-10-28)**: sin empezar, `request-end`, `end`, `renew` y `change-price` dan 400 `pre_opening_not_started` (se cancela como reserva). Cancelar devuelve también la fianza por la pasarela (Stripe/GoCardless); Redsys, efectivo y transferencia se avisan al equipo. Al abrir, una reserva sin firmar pasa a ser un alta normal desde la apertura; si una reserva no arranca, el local sigue en «próxima apertura» y el cron la reintenta (también las colgadas en un local ya abierto). Plazo máximo vencido sin abrir → aviso al inquilino y al equipo (`contract.pre_opening_deadline_passed`, una vez). Las subidas de precio y la actualización anual no tocan las reservas sin empezar; «Hoy» y el calendario no enseñan su fecha provisional.
- **Extras (2026-10-28)**: cupones con `preOpeningOnly` (solo reservas en un local por abrir; motivo `pre_opening_only`); los demás cupones también valen en una reserva anticipada. `GET /dashboard/today` → `preOpeningSoon` (locales que abren en 7 días o con reservas fuera de plazo). `GET /analytics/pre-opening?facilityId=` (`analytics:read`) → `{ facilities: [{ facilityId, facilityName, openingDate, totalUnits, reserved, unpaid, available, reservedMrr, potentialMrr, byType[] }] }`. Aviso por correo al equipo `facility_opened` (resumen del día de apertura). Al abrir, si el trastero reservado está en mantenimiento o bloqueado se asigna otro libre del mismo local, tipo y precio; si no hay, notificación `contract.pre_opening_unit_problem`.

### Otras formas de pago para el inquilino (2026-10-28)

- `GET/PATCH /settings/tenant/billing` ganan `offlineTransferEnabled`, `offlineCashEnabled` y `offlineSepaEnabled` (apagadas por defecto). Activar la transferencia sin IBAN → 400 `transfer_iban_required`; quitar el IBAN la apaga. Activar la domiciliación sin remesas SEPA activas con el domicilio del acreedor → 400 `sepa_not_enabled`.
- `GET /portal/me/payments/options` → `PortalPaymentOptionsDto { cardPayments, bankTransfer, payAtFacility, sepaDebit }` (la domiciliación también exige que el plan incluya SEPA).
- `POST /portal/me/invoices/:id/offline-payment {method: bank_transfer|cash|sepa_debit, iban?, bic?}` (sesión del portal) → `PortalOfflinePaymentResultDto { method, holdUntil, emailSentTo, mandateSigningUrl }`. Transferencia: correo con IBAN, importe (con la fianza que va en el mismo pago) y concepto (`source: offline_payment.transfer`). Transferencia o en el local amplían una vez 24 h (`OFFLINE_PAYMENT_EXTRA_HOURS`) el plazo de la reserva. Domiciliación: da de alta el mandato y devuelve el enlace para firmarlo (null si ya tiene uno firmado de esa cuenta); con el mandato firmado `expireUnpaidBookings` no cancela la reserva. Siempre: notificación `invoice.offline_payment_chosen` al equipo (también push). 400 `invoice_not_payable`, `offline_method_not_available`, `customer_without_email`; 404 `invoice_not_found`.
- `InvoiceDto.offlinePaymentMethod`: lo que eligió el inquilino; «Marcar pagada» lo propone. `POST /invoices/:id/mark-paid` admite `methodType` `sepa_debit` y `other` (el diálogo los ofrece).

### Revisión del área de clientes, arreglos (2026-10-28)

- `POST /portal/me/access/extra` y `POST /portal/me/access/night-pass` → 409 `no_active_contract` sin un trastero en uso (antes el acceso salía sin alcance y abría todos los locales). `GET /portal/me/access/night-pass` da `enabled: false` en ese caso.
- `GET /portal/me/access`: no incluye pases caducados ni ya usados; `PortalAccessCredentialDto.extra` marca los accesos adicionales que se creó el inquilino.
- `GET /portal/me/account`: `nextCharge` cuenta lo ya pagado por adelantado (último periodo facturado, `billingStartsOn`, con la parte proporcional si empieza a mitad de mes), los meses gratis, el descuento del prepago y no incluye las reservas antes de la apertura.
- `POST /portal/me/contracts {unitId, months?, couponCode?}` crea el contrato en borrador, reserva el trastero y devuelve `signingToken` (`PortalBookUnitResultDto`); la firma y la primera factura llegan al firmar en `/sign/<token>`. `signerName` ya no hace falta.
- Pedir la baja guarda la fecha de fin anterior (`contracts.end_date_before_ending`); cancelarla (portal) o aceptar una oferta de retención la devuelve si aún no ha pasado.
- Login por enlace o recuperación de contraseña con un email repetido: se elige el inquilino con contratos vivos y, si no, el más reciente.
- `PATCH /portal/me/profile`: con DNI/NIE/NIF/CIF (o sin tipo y país ES) valida el número → 400 `invalid_tax_id`; lo guarda normalizado.
- `POST /portal/me/logout` (cierra la sesión de este token en el servidor) y `POST /portal/me/sessions/close-all` (todas, también la actual).

**Mejoras del área de clientes (2026-10-28):**

- `POST /portal/me/unit-change-requests {contractId?, note?, targetUnitId?, desiredDate?}`: con `targetUnitId` (trastero libre del mismo local, si no 400) la nota es opcional. Los DTO llevan `targetUnitCode`, `desiredDate` y, en el panel, `targetUnitId`, `targetUnitPrice` y `currentPrice`; `PortalContractDto.facilityId`.
- `GET/POST /portal/me/authorized-persons` y `DELETE /portal/me/authorized-persons/:id`: personas autorizadas del propio inquilino.
- `POST /portal/me/access/visitor {authorizedPersonId? | name, facilityId?}`: PIN de un uso hasta medianoche en la hora del local, como mucho 3 al día, solo con un trastero en uso (409 `no_active_contract`); aviso al equipo `access.visitor_pass_created`.
- `GET /portal/me/contracts/:id/terms` → texto firmado del contrato (`PortalContractTermsDto`).
- `GET /portal/me/facilities`: `PortalFacilityDto` gana `imageUrls`, `openingHours`, `mapEmbedUrl`, `directionsUrl`, `whatsappNumber`, `myUnitCodes` y `plans` (plano de cada planta con sus trasteros marcados).
- `GET /portal/me/invoices/annual?year=` → `{url, year, invoices, withPdf}`: ZIP con el resumen en CSV y el PDF de cada factura del año (enlace de 1 h). 404 `no_invoices`, 400 `invalid_year`.
- `POST /portal/me/email-change {email}` (204; 400 `same_email` / `email_in_use`): enlace de 24 h al email nuevo y aviso al actual. `POST /portal/email-change/confirm {token}` (público, un solo uso) → `{email}`; página web `/portal/email-change?token=`.
- `DELETE /portal/me/documents/:id`: borra un documento que subió el propio inquilino (400 `document_added_by_staff` si lo añadió el equipo).
- `GET/PATCH /portal/me/preferences {marketing?, whatsapp?}` → `{marketing, whatsapp}`: baja de lo comercial (`marketingOptOutAt`) y de los avisos por WhatsApp (`whatsappOptOutAt`; el envío queda `skipped`).
- `POST /portal/me/contracts/:id/move-out-date {endDate}`: cambia la fecha de una baja en curso respetando el preaviso (a final de mes, como al pedirla) (400 `contract_not_ending` / `notice_period_not_met`); aviso al equipo `contract.move_out_date_changed`.
- `POST /portal/me/invoices/:id/redsys-redirect {…, extraInvoiceIds?}`: varias facturas (y sus fianzas) del mismo inquilino en una sola orden de tarjeta o Bizum; la notificación reparte el cobro entre ellas.

### Vencimientos y avisos (2026-10-29)

Función `business_reminders` (planes Starter, Pro y Administrador; sin ella 403 `feature_not_in_plan`). Permisos `reminders:read` (todos los roles) y `reminders:manage` (propietario y gestor). Respetan el alcance por local: un vencimiento sin local es de toda la empresa.

- `GET /business-reminders?includeDone=1` → `{items: BusinessReminderDto[], system: SystemDeadlineDto[]}`. Cada vencimiento lleva `daysLeft` (en la hora del negocio) y `state` (`overdue`|`soon` 7 días|`upcoming`|`paused`|`done`). `system` son los plazos que el sistema ya conoce, a un año vista y en solo lectura: certificado de la AEAT, documentos de los locales con caducidad, pago de la suscripción a mano y caducidad de la tarjeta guardada de Redsys.
- `POST /business-reminders` (`CreateBusinessReminderSchema`): título, tipo (`domain|hosting|rent|taxes|insurance|license|inspection|utilities|supplier|subscription|other`), fecha, repetición (`none|monthly|quarterly|semiannual|yearly|custom` + `intervalMonths`), días de aviso (`notifyDaysBefore`, por defecto 30/7/1/0), canales (correo, campana, móvil; al menos uno), destinatarios (`managers` = propietarios y gestores que ven el local, o `users` con `recipientUserIds`), hasta 5 `extraEmails` de fuera del equipo, avisos al estar vencido (`overdueReminders`, `overdueMaxDays`), importe, proveedor, enlace https y notas. 400 `invalid_recipients`, `facility_not_found`.
- `GET|PATCH|DELETE /business-reminders/:id` (PATCH admite `status: active|paused`; cambiar la fecha quita el «pospuesto»). Borrar quita también su historial y sus justificantes (los gastos apuntados se quedan).
- `POST /business-reminders/:id/snooze {days: 1-60}` → sin avisos hasta ese día (la fecha no cambia). 400 `reminder_not_active`.
- `POST /business-reminders/:id/receipt-upload-url {mimeType}` (PDF, PNG o JPG) → presigned PUT al bucket privado `uploads` (`<tenant>/reminders/<id>/…`).
- `POST /business-reminders/:id/complete {amount?, registerExpense?, note?, receiptKey?, receiptName?, receiptMime?}` → queda en el historial; si se repite pasa a la siguiente fecha (las fiscales vuelven al día oficial del calendario) y si no, a `done`. Con `registerExpense` y un importe crea el gasto (alquiler→`rent`, suministros→`utilities`, impuestos y licencias→`taxes`, seguros→`insurance`, revisiones→`maintenance`, proveedores→`supplies`, resto→`other`). El justificante se comprueba (tipo real, ≤10 MB, prefijo). Dos a la vez → 409 `reminder_done`.
- `GET /business-reminders/:id/completions` y `GET …/completions/:completionId/receipt` → `{url}` firmada 5 min.
- `GET /business-reminders/templates` → plantillas (`group` `fiscal`|`business`, `needsDate`, `count`, `applied`). `POST /business-reminders/templates/:key/apply {dueDate?, facilityId?}`: las fiscales (303, 111, 115, 130, 202, 390, 180/190, 347, 200, cuentas anuales) crean un vencimiento anual por cada fecha del calendario de la AEAT, pasada al lunes si cae en fin de semana (`templateKey` `fiscal_303:4-20`); las del negocio piden la fecha (400 `due_date_required`).
- `GET|PATCH /business-reminders/settings {weeklyDigest}` → `{weeklyDigest, icsUrl}`. `POST /business-reminders/settings/calendar` crea o cambia el enlace del calendario; `DELETE` lo desactiva.
- `GET /v1/public/reminders-calendar/:token` (sin sesión, 30/min) → `text/calendar` con los vencimientos activos (evento de día completo; los repetidos con `RRULE`, salvo los fiscales). 404 si el enlace no vale.
- `GET /dashboard/today` gana `businessRemindersDue` (vencidos y los de 7 días; con `?mine=1`, los de «propietarios y gestores» y los que te tienen elegido). El calendario (`GET /calendar`) incluye el tipo `business_reminder`.
- Avisos: cron `business-reminders.notices` (minuto 10 de cada hora, en el API). A partir de las 8:00 del negocio manda, por vencimiento, el aviso del hito más cercano ya alcanzado (`d30`, `d7`…), uno al día al estar vencido y el del día en que termina el «pospuesto»; cada aviso se reserva en `business_reminder_notices` antes de enviarse (sin duplicados). Campana por persona (tipo `business_reminder.due`, con push, o `business_reminder.notice`), correo a cada persona (`staff_notice`) y a los correos de fuera desde el remitente del negocio. Los lunes, el resumen semanal a propietarios y gestores si está activado.

### Blog del tenant: herramientas de SEO (2026-11-02)

- `POST|PATCH /blog-posts` aceptan `coverImageAlt` (≤200; vacío = el título) y `relatedPostIds` (hasta 3 entradas del mismo negocio, sin la propia; 400 `related_post_self` / `related_post_not_found`). `BlogPostDto` los devuelve.
- `POST /blog-posts/:id/cover/upload-url` acepta `fileName`: se limpia (`blogImageFileName`) y la clave queda `<tenant>/blog/<post>/<8 hex>/<nombre>.<ext>`. Al cambiar o quitar la portada se borra la anterior.
- `POST /blog-posts/images/upload-url {mimeType, sizeBytes, fileName?}` (`settings:manage`, `web_premium`): URL firmada para una imagen del texto del post (comparativas), sin necesidad de guardar el post; clave `<tenant>/blog/images/<8 hex>/<nombre>.<ext>`. `POST /blog-posts/images/confirm {key}` comprueba que la clave es del tenant (404 `invalid_image_key`) y los bytes reales, y devuelve `{url}`. No se borran al borrar el post.
- **Comparativa** en el Markdown del post: entre `[[comparativa]]` y `[[/comparativa]]`, una línea por columna (2 a 4) `imagen https | título | subtítulo` (`splitBlogContent` → bloque `comparison`, `comparisonBlock`); mal escrita se queda como texto. Tablas Markdown (`| a | b |`) con `remark-gfm`.
- `GET /public/landing/:slug/blog/:postSlug` añade `post.coverImageAlt` y `related` (las elegidas que sigan publicadas, en su orden; sin ninguna, las 3 últimas publicadas). Los resúmenes (`posts`, `latestBlogPosts`, `related`) llevan `coverImageAlt`.
- Contenido: enlaces a la web como `[texto](web:<destino>)` con `precios`, `reservar`, `contacto`, `calculadora`, `blog`, `local/<slug>`, `pagina/<slug>` (ciudad o zona), `post/<slug>` y `promo/<slug>`; la web los traduce a la dirección de trasteros.pro o del dominio propio. Bloques en una línea propia: `[[boton: Texto | destino]]` (destino `web:…` o `https://…`), `[[calculadora]]`, `[[tamanos]]`, `[[locales]]` (`splitBlogContent` en shared).

### Comunicación del panel admin: arreglos (2026-11-02)

- `POST /admin/tenants/:id/email`: si el correo no llega a nadie → 502 `email_send_failed` y no se guarda nada. El ticket queda `openedByAdmin` (no cuenta en `GET /admin/support/stats` ni en `GET /support/tickets/waiting-count` hasta que el tenant conteste).
- `POST /admin/announcements` admite `commercial` (por defecto false): lleva enlace de baja (token `u.<userId>.<firma>` en `/public/unsubscribe/:token`) y no llega a los usuarios dados de baja. La respuesta gana `skipped` (tenants sin destinatario o dados de baja) y `optedOut`; `recipients` = correos encolados. Con `tenantIds`, nunca a tenants dados de baja.
- `GET /support/platform-messages?cursor=` → `{items, nextCursor, unread}` (30 por página; cada mensaje con `readAt`). `POST /support/platform-messages/read` (204) los marca leídos.
- `PUT /admin/platform/banner` admite `endsAt` (ISO o null) y `dismissible`; `GET /platform-banner` no devuelve un banner pasada su fecha de fin y lleva `updatedAt` (para recordar que se cerró). Un banner `critical` nunca es `dismissible`.
- Novedades: el enlace admite `#ancla`; volver a publicar conserva la fecha de la primera publicación.

### Comunicación del panel admin: mejoras (2026-11-02)

- **Anuncios** (lectura: también soporte; escribir: rol superadmin): `GET /admin/announcements/history`, `POST /admin/announcements/preview {segment, commercial}` → `{tenants, recipients, optedOut, sample}`, `POST /admin/announcements/drafts`, `GET|PUT|DELETE /admin/announcements/:id` (solo borradores y programados se editan; solo borradores y cancelados se borran), `POST …/:id/send {scheduledFor|null}` (null = ahora; 409 `announcement_busy` si ya se envía), `POST …/:id/cancel`, `POST …/:id/duplicate`, `POST …/:id/resend-missing`. `POST /admin/announcements` (envío inmediato) también queda en el historial. Segmento: `audience`, `tenantIds`, `tag`, `plans`, `addons`, `missingAddons`, `health`, `inactiveDays`, `minFacilities`, `maxFacilities`; los segmentos se guardan en `/admin/saved-views` con `page=announcements`. Variables `{empresa}` y `{nombre}`; botón `[[boton: Texto | https://…]]`.
- **Correo directo**: `AdminEmailTenantSchema` gana `replyExpected` (false = sin ticket) y `attachments` (≤5, PDF o imagen, ≤10 MB) subidos con `POST /admin/tenants/:id/email/upload-url {fileName, mimeType, size}`. El tenant los descarga con `GET /support/platform-messages/:id/attachments/:index` → `{url}`.
- **Banners**: `GET|POST /admin/platform/banners`, `PUT|DELETE /admin/platform/banners/:id` (sustituyen a `GET|PUT /admin/platform/banner`). Campos nuevos: `startsAt`, `linkUrl`, `linkLabel`, `plans`, `statuses`, `priority`. `GET /platform-banner` devuelve el de más prioridad que le toca al tenant (con `linkUrl`/`linkLabel`).
- **Correos enviados**: `GET /admin/email-log?announcementId=`, `GET /admin/email-log/stats?weeks=`, `GET /admin/email-log/problems`, `GET /admin/email-log/export` (CSV), `GET /admin/email-log/:id/body`, `POST /admin/email-log/:id/resend` (superadmin; 400 `email_not_resendable` en los de cuenta). `PlatformEmailLogDto` gana `hasHtml` y `announcementId`.
- **Novedades**: `UpsertProductUpdateSchema` gana `publishAt`, `highlighted` e `imageKey` (`POST /admin/product-updates/image-upload-url`); `AdminProductUpdateDto` gana `scheduled`, `highlighted`, `imageUrl`, `seenBy`.
- **Correos automáticos**: `GET /admin/email-templates`, `PUT /admin/email-templates/:code {subject, body}`, `DELETE /admin/email-templates/:code` (vuelve al de serie); códigos `welcome`, `trial_ending`, `trial_ended`, `past_due`.
- **Encuestas NPS**: `GET|POST /admin/nps-surveys`, `GET|DELETE /admin/nps-surveys/:id`, `POST …/:id/send`, `POST …/:id/close`; públicos `GET|POST /public/platform-nps/:token {score 0-10, comment?}` (404 `survey_not_found`, 400 `survey_closed`).

### Plataforma del panel admin: arreglos (2026-11-02)

- `GET /admin/platform/contact/messages?cursor=&search=&handled=` → `{items, nextCursor, pending}` (30 por página). `DELETE /admin/platform/contact/messages/:id` (superadmin, auditado). Cambiar los ajustes del formulario y marcar un mensaje como atendido quedan en el registro del admin.
- `POST /admin/platform-alerts/run` exige el rol superadmin.
- `GET /admin/email-settings/platform-domain` y `GET /admin/email-settings/brevo-domains/unused` se guardan 5 minutos; `?refresh=1` vuelve a preguntar a Brevo y Resend.
- `PUT /admin/platform/website/logo` y `…/og-image` comprueban que los bytes son PNG, JPG o WebP de hasta 1 MB (400 `invalid_file_content`/`file_too_large`) y borran del bucket la imagen anterior.
- `PUT /admin/platform/legal/:slug`: el contenido no puede tener menos de 20 caracteres.
- Tipo de correo de la plataforma nuevo `admin_alert` («Alertas y resumen al administrador», remitente de «Avisos al equipo»).

### Plataforma del panel admin: mejoras (2026-11-03)

- Contacto de la web: `PUT /admin/platform/contact/messages/:id {note?, assignedToId?}` (400 `invalid_assignee`), `POST …/messages/:id/reply {subject, body}` (correo con el remitente «Contacto web», marca atendido; 400 `email_suppressed`), `GET …/messages/export.csv?search=&handled=`. Los DTO llevan `note`, `assignedToId/Name`, `repliedAt`, `replySubject`, `replyBody`. Cada mensaje nuevo avisa por Telegram/Slack (`platform_alert_settings.chat_contact_enabled`).
- Portada: `PUT /admin/platform/website/home {heroTitle, heroSubtitle, heroNote, faq}` (superadmin); `PlatformWebsiteDto.home` (null = texto de serie).
- Legales: `PUT /admin/platform/legal/:slug` acepta `notifyTenants` y guarda una versión; `GET /admin/platform/legal/:slug/versions[/:id]`; `GET /admin/platform/legal-fill` (huecos que se pueden rellenar con los datos de Facturación SaaS y los que faltan). Tenant: `GET /platform-legal-pending` y `POST /platform-legal-pending/:versionId/accept` (solo propietario, 403 `owner_required`).
- Correo saliente: `GET /admin/email-settings/usage` (últimas 24 h por proveedor, respaldo y créditos de Brevo); `PlatformDomainStatusDto.brevoRecords`.
- Asistente IA: `GET /admin/ai-settings/usage` (uso, coste, previsión y los que más gastan); `PUT /admin/ai-settings` acepta `monthlyCostAlertUsd` y `planLimits`; `POST /admin/ai-settings/test {prompt?}` devuelve `answer`.
- IA de WhatsApp: `PlatformWhatsappAiDto.usage`; `POST /admin/whatsapp-ai/test {message?}` (conversación simulada).
- Alertas: `alertEmail` admite varios separados por comas; `dailyHour`, `chatContactEnabled`; `GET /admin/platform-alerts/log` (últimos 100 avisos por email y chat).

## Seguridad y sistema del panel admin (2026-11-04)

| Método | Ruta                                 | Acceso     | Notas                                                                             |
| ------ | ------------------------------------ | ---------- | --------------------------------------------------------------------------------- |
| GET    | `/admin/security-settings`           | AdminGuard | Política de 2FA y cuántos super admins no la tienen                               |
| PUT    | `/admin/security-settings`           | superadmin | `{requireAdminTwoFactor, adminTwoFactorGraceDays}`. 400 `own_two_factor_required` |
| PATCH  | `/admin/super-admins/:id/role`       | superadmin | `{role}`. 400 `cannot_modify_self`, `last_super_admin`                            |
| POST   | `/admin/super-admins`                | superadmin | `password` opcional: sin ella se envía un enlace de 7 días                        |
| GET    | `/admin/impersonation-logs`          | AdminGuard | Ahora `{items, nextCursor}`. Filtros `?tenantId=&superAdminId=&cursor=&limit=`    |
| POST   | `/admin/queues/:name/jobs/:id/retry` | superadmin | Reintenta un job fallido. 404 `job_not_found`                                     |
| DELETE | `/admin/queues/:name/jobs/:id`       | superadmin | Elimina un job fallido                                                            |
| DELETE | `/admin/crons/:name`                 | superadmin | Quita una tarea de la lista                                                       |

Con la 2FA obligatoria y el plazo vencido, las rutas admin responden 403 `admin_two_factor_required`, salvo `/admin/auth/*` y `GET /admin/security-settings`. `POST /admin/webhooks-cleanup/run` exige `olderThanDays` de 7 o más.

### Mejoras (2026-11-04)

| Método | Ruta                                      | Acceso     | Notas                                                              |
| ------ | ----------------------------------------- | ---------- | ------------------------------------------------------------------ |
| GET    | `/admin/auth/sessions`                    | AdminGuard | Tus sesiones abiertas, con `current`                               |
| DELETE | `/admin/auth/sessions/:id`                | AdminGuard | Cierra una sesión tuya                                             |
| GET    | `/admin/super-admins/:id/sessions`        | superadmin | Sesiones de otro super admin                                       |
| POST   | `/admin/super-admins/:id/revoke-sessions` | superadmin | Las cierra todas                                                   |
| GET    | `/admin/security-blocks`                  | AdminGuard | Bloqueos vigentes                                                  |
| POST   | `/admin/security-blocks`                  | superadmin | `{kind, value, reason?, expiresInHours?}`. 400 `cannot_block_self` |
| DELETE | `/admin/security-blocks/:id`              | superadmin | Quita un bloqueo                                                   |
| GET    | `/admin/queues/:name/failed?page=`        | superadmin | Fallidos con sus datos, 25 por página                              |
| POST   | `/admin/queues/:name/pause`, `/resume`    | superadmin | Pausa o reanuda una cola                                           |

`GET /admin/security-events/stats` añade `adminLogins` y `tenantId`/`tenantName` en `topEmails`. `GET /admin/impersonation-logs` añade `actionsCount`. `PUT /admin/security-settings` admite `alertCooldownMinutes`.

## Fianza en el local (2026-11-04)

| Método | Ruta                                         | Acceso          | Notas                                                                                                               |
| ------ | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| POST   | `/public/move-in/sign/:token/deposit-method` | Enlace de firma | `{method: online\|cash}`. Solo reserva online sin firmar con «Pagar en el local» activo. Devuelve la vista de firma |

`POST /contracts/:id/deposit/collect` admite `methodType: card` (TPV físico).

## «Hoy» del panel admin (2026-11-04)

`POST /admin/today/addon-charges/:id/charge` responde 409 `addon_not_chargeable` si el extra ya no se cobra a mano y 409 `addon_already_charged` si ya está registrado. `kpis.pending` de `GET /admin/today` es el total de `GET /admin/billing/receivables`.

### Mejoras de «Hoy» (2026-11-04)

| Método | Ruta                       | Acceso     | Notas                                                       |
| ------ | -------------------------- | ---------- | ----------------------------------------------------------- |
| POST   | `/admin/today/snoozes`     | AdminGuard | `{kind, ref, label?, days}`. Aparta un aviso de 1 a 90 días |
| DELETE | `/admin/today/snoozes/:id` | AdminGuard | Lo recupera                                                 |

`GET /admin/today` añade `followupsUpcoming`, `contactMessages`, `domainsReady`, `incompleteInvoices`, `rgpdOverdue`, `npsNegative`, `activationStalled`, `workload`, `snoozes`, `done`, `usage` en las pruebas y la asignación en los tickets. `PUT /admin/platform-alerts` admite `instantAlertsEnabled`.

### Revisión de «Hoy» (2026-11-21)

| Método | Ruta                   | Acceso     | Notas                                                                             |
| ------ | ---------------------- | ---------- | --------------------------------------------------------------------------------- |
| GET    | `/admin/today?fresh=1` | AdminGuard | La bandeja sin la copia de 30 s (la pide la página)                               |
| GET    | `/admin/today/count`   | AdminGuard | `{urgentCount}` para el contador del menú; de la bandeja guardada 30 s en memoria |

- Apartar un aviso guarda cómo estaba (`admin_today_snoozes.fingerprint`): último mensaje del cliente en un ticket, deuda y cuotas de un impago, nº de dispositivos sin conexión, fallos de webhooks, facturas con problemas, cobro de un extra, certificado caducado o renovación vencida. Si empeora, vuelve a salir con `reappeared: true` y `reappearedReason` («El cliente ha vuelto a escribir», «La deuda ha subido»…), cuenta como urgente y deja de figurar en `snoozes`. Los demás tipos siguen ocultos hasta que vence.
- Cada sección se carga por separado: si una falla, llega vacía y su clave sale en `failedSections` (`ADMIN_TODAY_SECTION_LABELS` en shared); el resto de la bandeja no cambia.
- `failedJobs` cuenta solo los trabajos fallidos de las últimas 24 h. `failedWebhooks` solo trae los webhooks con fallos posteriores a su última entrega correcta. Los leads asignados a un comercial salen pero no son urgentes. `urgentCount` = `adminTodayUrgentCounts` (shared), la misma cuenta que usan las pestañas de la web. `done.ticketsAnswered` cuenta tickets distintos. Los tickets traen `lastTenantMessageAt`.
- Cobrar un extra de un tenant dado de baja → 409 `addon_not_chargeable`; ya no salen en `addonCharges` ni cuentan en `workload` los tickets o seguimientos de tenants de baja. `DELETE /admin/today/snoozes/:id` queda en el registro (`admin.today.unsnoozed`).
- El aviso inmediato (`today-watch`) solo avisa cuando hay novedad (estado distinto del ya avisado en 30 días) y, como mucho, una vez al día por ticket, impago o tenant.

### «Hoy»: prioridades, acciones en lote y última visita (2026-11-21)

| Método | Ruta                              | Acceso                | Notas                                                                                                                                                                             |
| ------ | --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/admin/today/visit`              | AdminGuard            | `AdminTodayVisitDto`: lo nuevo, lo resuelto y lo que ha empeorado desde la última visita (`show` solo si fue hace 1 h o más) y guarda la foto de ahora. La página lo pide una vez |
| POST   | `/admin/today/batch`              | AdminGuard            | `{action: snooze\|assign\|remind, days?, items: [{kind, ref, label?}]}` (1-100). `remind` solo superadmin (403 `insufficient_super_admin_role`). → `{done, failed[]}`             |
| POST   | `/admin/today/failed-jobs/retry`  | AdminGuard superadmin | `{jobs: [{queue, id}]}` (1-100). Reintenta trabajos fallidos de las colas → `{done, failed[]}`                                                                                    |
| POST   | `/admin/today/failed-jobs/review` | AdminGuard superadmin | Igual: los marca revisados (`admin_reviewed_jobs`); dejan de contar hasta que vuelvan a fallar                                                                                    |

- `GET /admin/today` añade `assignedLeads` (asignados sin respuesta en más de 24 h; `newLeads` pasa a ser solo los sin asignar), `paymentFailures` (cobros de la suscripción rechazados en 48 h: Stripe, tarjeta de Redsys y adeudos SEPA devueltos; uno por tenant, fuera si paga después; urgentes), `inactivePaying` (clientes de pago sin acceso de su equipo en 14 días, con su cuota; no urgentes), `failedJobsList` (los 20 fallidos más recientes de 24 h sin revisar; `failedJobs` es el total), `moneyAtRisk {total, pastDue, trialsEnding, addonCharges, inactive}` y `responseTargets` (plazo de respuesta por prioridad, el de `GET /support/response-times`).
- Los tickets traen `responseTargetHours`, `dueAt` y `dueInHours` (negativo = fuera de plazo) y salen por lo que vence antes; solo son urgentes los que vencen en menos de 2 h o ya vencieron (`TICKET_URGENT_HOURS`). Las pruebas, renovaciones y tickets traen `monthly` (lo que paga el tenant).
- Orden: extras por días de retraso e importe, renovaciones y certificados por lo que vence antes, pruebas por días y uso, impagos y cobros rechazados por importe, leads del más antiguo al más nuevo, pruebas sin arrancar de la más reciente a la más antigua, NPS por la nota más baja y el resto por número de incidencias.
- Tipos nuevos de `TodaySnoozeKindEnum`: `payment_failure` (huella: último rechazo) e `inactive` (huella: último acceso). `adminTodayUrgentCounts(d, {mine})` cuenta los leads asignados sin atender solo en «Lo mío».

### «Hoy» del panel del tenant (2026-11-05)

`GET /dashboard/today` acepta `full=1` (listas enteras, modo mostrador). Cada apartado sale solo con su permiso de lectura; sin él llega vacío y no cuenta en `urgentCount`. `TodayItemDto.note` marca las facturas con cobro en curso o en plan de pagos. `GET /dashboard/today/summary` añade `kpis.moneyVisible`. `POST /invoices/bulk/remind` devuelve en `failed` los códigos `payment_in_progress` e `invoice_in_payment_plan`.

`GET /dashboard/today/extras?facilityId=&mine=` devuelve los avisos que completan la bandeja, la deuda por inquilino, mañana, la semana, lo hecho hoy y lo apartado. `POST /dashboard/today/snoozes {kind, refId, days, label?}` y `DELETE /dashboard/today/snoozes/:id` apartan un aviso (`tasks:write`). `GET /dashboard/today/desk/customers/:customerId/access` da el código de acceso (`access:manage`, queda registrado). `GET/PUT /dashboard/me/daily-summary {hour, facilityIds, push}` guarda el resumen del día de cada persona.

## Alta de un tenant (2026-11-05)

- `POST /auth/forgot-tenant {email}` (público, 204 siempre): envía por correo los identificadores de empresa de ese email.
- `GET /dashboard/onboarding` pasa a `facilities:manage` (propietario y gestor) y añade `web {url, published, bookable, missing}`; cada paso lleva `skippable`, `skipped` y `skipLabel`.
- `PUT /dashboard/onboarding/steps/:key {skipped}` (`facilities:manage`): da un paso por resuelto o lo devuelve a pendiente; 400 `step_not_skippable` si el paso no lo admite.
- `GET /public/landing/:slug`, `/:slug/:facilitySlug` y `/:slug/promo/:promoSlug` dan 404 `web_not_published` sin cuenta activada o sin local. `GET /public/landing/brand/:slug` añade `webPending` y `bookingPending`.
- `/public/move-in/book/:slug/*` da 409 `booking_unavailable` sin datos fiscales o sin forma de cobro.

- `PUT /dashboard/onboarding/state {path?, wizard?}` (`facilities:manage`): punto de partida (`new`, `opening`, `migrating`) y paso por el asistente. `GET /dashboard/onboarding` añade `path`, `wizardPending` y `testRun`.
- `POST /dashboard/onboarding/test-run` crea el inquilino de prueba con el email de quien lo pide (400 `no_unit_available`, 409 `test_run_exists`) y `DELETE` lo borra y libera su trastero. No se le factura. `ContractSignViewDto.isTest`.

- `GET /dashboard/onboarding/next-step` (`facilities:manage`) → `{step}`: con lo imprescindible hecho, la siguiente sugerencia (primera semana, primer mes y más adelante) según lo que aún no usa y su plan. `POST /dashboard/onboarding/next-step/:key/dismiss` la descarta y devuelve la siguiente.

### Resumen del panel (2026-11-05)

- `GET /dashboard/overview?facilityId=` (`analytics:read`; 400 `invalid_facility_id`): todas las cifras del Resumen en una respuesta (`month`, `revenue`, `occupancy`, `customers`, `receivables`, `monthlyRevenue`, `forecast`, `churnRisk`, `leads`). Una sección que falla llega a `null` y las demás no se ven afectadas.
- Las cifras salen de `modules/analytics/business-metrics.ts`, también en `/dashboard/today/summary` y `/analytics/*`: el inquilino de prueba no cuenta; lo facturado es neto de abonos y una sustitutiva cuenta solo la diferencia; altas y bajas siguen `contractLifecycle` (una reserva online cuenta al pagarse; una cancelación de un contrato en marcha es una baja); `newThisMonth` son inquilinos con su primer contrato en el mes; los meses se cortan en la zona del tenant.
- `GET /analytics/occupancy` añade `byStatus`; `GET /analytics/forecast` añade `assumptions.cappedAtCapacity` (la proyección no pasa de los trasteros que hay); `GET /collections/summary` admite `?facilityId=`; `GET /auth/me` añade `subscription.planName`.

- `GET /dashboard/overview` admite `?period=month|last_month|3m|12m|year` (400 `invalid_period`) y añade `period` (facturado, cobrado, altas, bajas e inquilinos nuevos frente al periodo anterior), `cash` (caja del mes en curso), `vacancy` (trasteros libres por tamaño, lo que dejan de ingresar y los días libres), `moves` (altas y bajas del periodo; entradas, salidas y vencimientos de los próximos 30 días; exige `contracts:read`), `byFacility`, `result` (facturado sin IVA menos gastos; exige `expenses:read`) y `commercial` (contactos sin atender y abiertos, contratos por firmar, reservas sin pagar, lista de espera).
- `GET/PUT /dashboard/me/layout`: orden y tarjetas ocultas del Resumen, por usuario (`DashboardLayoutSchema`; sin nada guardado, el orden por defecto).

### Mensajería: revisión (2026-11-06)

- `GET /customers/:customerId/messages?before=<id>` y `GET /portal/me/messages?before=<id>`: 50 mensajes por página, de más viejo a más nuevo. Sin `before`, los últimos (y marca leídos); con él, los anteriores.
- `GET /customer-messages/unread-summary` y `/conversations` respetan el alcance por local: inquilinos con contrato en sus locales y los que no tienen contrato vivo.
- `POST /portal/me/messages` y `…/upload-url`: 20 por minuto.
- `GET /support/tickets` gana `unreadCount` (respuestas sin leer por quien mira). `GET /support/tickets/waiting-count`: tickets con respuesta sin leer. `GET /support/tickets/:id` deja leído para quien lo abre.
- `POST /admin/support/tickets/:id/messages` en un ticket cerrado: 400 `ticket_closed` salvo nota interna. Responder en `in_progress` pasa a `waiting_user`.
- `GET /support/platform-messages*` exigen `platform_messages:manage`; `unread`, `readAt` y `POST …/read` son por persona.
- Notificaciones nuevas: `customer.message_unanswered` (también al móvil) y, en el super admin, `inbound.unmatched`.

### Mensajería: mejoras (2026-11-06)

- `GET /customer-messages/inbox?channel=all|customers|whatsapp|web&status=&mine=1&search=&facilityId=&cursor=` (`customers:read`) → `{items, nextCursor, counts}`. Con `status`, `mine` o `facilityId` solo salen inquilinos. WhatsApp y chat de la web, solo con su función y permiso. 400 `invalid_filter`.
- `GET /customers/:id/messages/context` → estado, responsable, si le llega (`reach`) y variables de las respuestas guardadas. `PATCH /customers/:id/messages/conversation {status?, assignedUserId?}` (`customers:write`; 400 `invalid_assignee`).
- `POST /customers/:id/messages` admite `attachments` (hasta 5) e `isInternal`. Cada mensaje devuelve `attachments`, `isInternal` e `isAuto`; el área de clientes no recibe las notas.
- `POST /customer-messages/broadcast {customerIds, body}` (`customers:write`) → `{sent, skipped}`.
- `GET /customer-messages/stats?days=` (`customers:read`). `GET/POST /customer-messages/canned`, `PATCH/DELETE /customer-messages/canned/:id`. `GET/PUT /customer-messages/settings` (400 `message_hours_required`).
- `POST /support/tickets/:id/close`, `POST /support/tickets/:id/rating {score, comment?}` (400 `ticket_not_finished`, 409 `ticket_already_rated`). `GET /admin/support/stats` gana `avgRating` y `ratedTickets`.
- `POST /webhooks/email-inbound` admite `to` y `attachments`; `text` puede ir vacío si lleva adjuntos.
- Canales en vivo (Server-Sent Events, sin contenido, solo `{type, customerId?, ticketId?}`): `GET /realtime/stream`, `GET /portal/me/stream`, `GET /admin/support/tickets/stream`. El servidor corta a los 14 minutos para que el cliente se reconecte con un token vigente.

> **2026-11-12 (primera factura al cobrar)** — `InvoiceDto.issueOnPayment`: borrador del primer pago de una reserva online (`status: 'draft'`, `amountPending` > 0, número `DRAFT-…` hasta que se cobra). Se puede cobrar como una emitida: `POST /portal/me/invoices/:id/charge`, `/redsys-redirect` (también en `extraInvoiceIds`; descripción «Primer pago de la reserva»), `/offline-payment` (transferencia con el número de contrato como concepto; domiciliación → se emite al firmar el mandato), `POST /payments/invoices/:id/charge` y `POST /invoices/:id/mark-paid` (la emite y aplica el cobro). Antes de cobrar, 400 con el mismo código que `issue` si no se podría emitir. `GET /portal/me/invoices` la incluye con `status: 'draft'`. `GET /public/move-in/sign/:token` → `termsText` con «Entrada en vigor: con el primer pago…» en la reserva online.

> **2026-11-13 (Gastos y Fiscalidad)** — `GET /expenses/total?facilityId&category&from&to&search` → `{count, amount}`. `ExpenseDto.source` (`manual`|`recurring`|`google_ads`|`meta_ads`) y `recurringExpenseId`. `ProfitLossDto.invoicesVisible`/`paymentsVisible`; `invoiced` y `net` sin IVA. Errores nuevos: 400 `invalid_date`, `invalid_facility_id`, `invalid_category`, `invalid_range` (cuenta de resultados sin periodo), `facility_not_found`, `marketing_channel_not_found`; 403 `facility_required`; 409 `expense_synced`. Fiscalidad: 403 `fiscal_requires_all_facilities` para quien solo ve unos locales; `GET /fiscal/model-303` → 400 `invalid_quarter` con un trimestre que no es 1-4.

> **2026-11-13 (mejoras de Gastos)**

**Gasto**

- `CreateExpenseSchema`:
  - `amount` (sin desglosar) o `baseAmount` + `vatRate`, `vatDeductible`, `withholdingRate` y `withholdingModel` (111|115; obligatorio con retención: 400 `withholding_model_required`);
  - `supplierId`, `vendorTaxId` e `invoiceNumber`;
  - `receiptKey`, `receiptName` y `receiptMime`;
  - `paymentStatus` (paid|pending), `paidAt`, `paymentMethod` (cash|card|bank_transfer|direct_debit|other) y `dueDate`;
  - `category`: una de las de siempre o `custom:<id>`.
- `ExpenseDto` añade `categoryLabel`, `broken`, el desglose, `totalAmount`, `supplierName`, `hasReceipt`, el pago, `overdue`, `cashMovementId` y `cashNotice` (aviso si la caja de ese día estaba cerrada).
- Filtros de la lista, el total y la exportación: `paymentStatus` (paid|pending|overdue) y `supplierId`. La búsqueda también mira el NIF y el número de factura.
- `GET /expenses/export` devuelve todo lo filtrado (hasta 5.000).
- `GET /expenses/total` devuelve `{count, amount, pending}`.
- `POST /expenses/:id/mark-paid {paidAt, paymentMethod}` y `POST /expenses/:id/mark-pending`.
- `POST /expenses/bulk` con `action` category|facility|mark_paid|delete → `{succeeded, failed}`.

**Justificante**

- `POST /expenses/receipt-upload-url {mimeType}` (PDF, PNG o JPG, máx. 10 MB).
- `GET /expenses/:id/receipt`: URL firmada de 5 min.
- `POST /expenses/receipts/read {key}`: lee el justificante con IA. 403 `feature_not_in_plan` sin el asistente IA; gasta una consulta.

**Cuenta de resultados y presupuesto**

- `GET /expenses/profit-loss?allocation=none|units|area|invoiced` (400 `invalid_allocation`). Las filas añaden `allocatedGeneral` y `margin`; la respuesta, `previous` (el mismo número de días justo antes) y `byCategory[].budget`.
- `GET /expenses/profit-loss/monthly?from&to&facilityId`: como mucho 24 meses.
- `GET/PUT /expenses/budgets`.

**Recurrentes**

- `CreateRecurringExpenseSchema` añade `frequency`, `startDate`, `endDate`, `supplierId`, el desglose y `paymentMethod`.
- `RecurringExpenseDto` añade `nextDate` y `missedDates`.
- `POST /expenses/recurring/:id/catch-up` genera las fechas que se quedaron sin generar.

**Proveedores y categorías**

- `GET/POST/PATCH/DELETE /expense-suppliers` (`?search&all=1`; 409 `supplier_tax_id_taken`).
- `GET/POST/PATCH/DELETE /expense-categories` (409 `category_name_taken`; al borrar una, sus gastos pasan a «Otros»).

**Importación y caja**

- `GET /imports/expenses/template` y `POST /imports/expenses/preview|commit` (`imports:manage` + `expenses:manage`).
- Caja: no se puede borrar un movimiento `expense_payment` (409 `movement_from_expense`).

**«Hoy»**

- `TodayDto.expensesToPay`.

### Cartera (2026-11-14)

- `GET /portfolio/price-changes?facilityId=` (`contracts:read`): cambios de cuota previstos (`source`: `scheduled`, `rent_increase` con su tanda e item, `anniversary` por revisar), solo los que se aplicarán de verdad.
- `GET /portfolio/renewals?window=30|60|90|overdue&facilityId=` (`contracts:read`; otro valor → 400 `invalid_window`): contratos que vencen con cuota, descuento, antigüedad (`monthsAsCustomer`), deuda vencida, teléfono, email, riesgo de baja (`risk`, `riskFactors`) y oferta de renovación pendiente.
- `GET /contracts/:id/price-history` (`contracts:read`): `entries` con el alta, cada cambio (`from`, `to`, motivo) y lo previsto (`kind: scheduled`).
- `POST /contracts/:id/renewal-offer {months, newPrice?, note?}` (`contracts:manage`): crea un anexo «Renovación del contrato» y lo envía a firmar; al firmarlo se renueva solo (`renew` con el fin que tenía). Si el contrato cambió, el anexo queda firmado con `actionError` y aviso al equipo (`contract.renewal_accepted`). 409 `renewal_offer_pending`, `price_change_pending`; 400 `contract_indefinite`, `discount_too_high`. Los anexos (`ContractAnnexDto` y `/portal/me/annexes`) llevan `renewal` y, en el panel, `actionAppliedAt`/`actionError`.
- `PUT /contracts/:id/rent-increase-exemption {until: YYYY-MM-DD | null, reason?}` (`contracts:manage`, 204; 400 `invalid_until` con fecha pasada) y `PUT /contracts/:id/anniversary-pct {pct: -20…30 | null}` (`contracts:manage`, 204). `ContractDto` gana `rentIncreaseExemptUntil`, `rentIncreaseExemptReason` y `anniversaryUpdatePct`.
- Correo nuevo al inquilino `contract_auto_renewal_notice`: 30 días antes de la prórroga automática (con el evento `contract_ending_soon`), con la nueva fecha y el último día para darse de baja.

### Operaciones diarias: revisión (2026-11-14)

**Tareas**

- `POST /tasks/:id/transition`: `open → done` directo y `done|cancelled → open` (reabrir: limpia `completedAt`, `cancelledAt`, `cancelReason`). Dos cambios a la vez → 409 `task_changed`.
- `POST|PATCH /tasks`: `dueDate` con fecha real; `description`, `facilityId`, `unitId`, `assignedToUserId` y `dueDate` admiten `null` para vaciarlos. 400 `facility_not_found`, `unit_not_found`, `unit_not_in_facility`, `assignee_not_found` (inexistente o desactivado). Con solo `unitId`, la tarea toma su local.
- `GET /tasks` y `/tasks/page`: un `status`, `type` o id mal escrito → 400 `invalid_filter` / `invalid_id`.
- `PATCH /tasks/:id/checklist/:itemId` bloquea la fila. `ChecklistItemDto.incidentId`: la incidencia abierta desde ese punto.
- `PUT /tasks/auto-rules`: 403 `requires_all_facilities` a quien solo ve unos locales. La de «llamar para renovar» guarda `metadata.endDate` (una por vencimiento).

**Incidencias**

- `CreateIncidentSchema.visibleToCustomer` y `UpdateIncidentSchema.visibleToCustomer` (solo con inquilino); `IncidentDto.visibleToCustomer`. Las del área de clientes nacen visibles y se enlazan a su contrato, trastero y local si tiene uno solo.
- Alta y edición validan local, trastero, inquilino, contrato y responsable (400 `contract_not_for_customer`, `unit_not_in_facility`, `assignee_not_found`…); lo que falte se toma del contrato o del trastero. `PATCH` admite `null` en `facilityId`, `unitId`, `customerId`, `contractId`, `occurredAt`, `assignedToUserId`.
- Desde un punto de una ronda (`metadata.source = 'checklist'`, `taskId`, `checklistItemId`): una sola incidencia abierta por punto (409 `incident_already_open` con `details.incidentId`).
- Reabrir borra `resolution`. Dos cambios a la vez → 409 `incident_changed`.
- `GET /incidents/pending-counts` cuenta los locales del usuario (y las de toda la empresa).
- `GET /portal/me/incidents`: solo `visibleToCustomer`; `PortalIncidentDto` gana `resolution` y `closedAt` (cerradas).
- El aviso `incident.created` enlaza a `/incidents?incident=<id>`.

**Mantenimiento**

- Inicio pasado → empieza hoy (en la zona del negocio). `PATCH` solo recalcula `nextRunDate` si cambia la frecuencia o `startDate`; reactivar con la fecha pasada sigue desde hoy. Local y responsable validados (400 `facility_not_found`, `assignee_not_found`).
- `POST /maintenance-plans/:id/run` → `{generated, dueDate, reason?}`: crea ya la siguiente tarea; `reason: 'open_task'` si la anterior sigue abierta. Cada tarea generada con responsable le envía el aviso `task.assigned`.

**Calendario**

- `GET /calendar` ya no exige `tasks:read`: cada tipo sale con su permiso (`tasks:read` tareas y mantenimiento; `contracts:read` entradas, fin, prórroga y cuotas; `reservations:read` reservas; `reminders:read` vencimientos). Fechas reales y `facilityId` válido (400 `invalid_range` / `invalid_id`).
- Tipo nuevo `contract_renewing` (renovación automática sin baja pedida). Mantenimiento: una entrada por repetición del rango (`id` = `<planId>:<fecha>`). Sin tareas borradas.

**Vencimientos**

- `POST /business-reminders/:id/complete`: reserva antes de apuntar el gasto (un doble clic → 409 `reminder_done` sin gasto de más). Los que se repiten guardan `anchorDay` y vuelven a ese día (31 → 28 de febrero → 31 de marzo).
- `PATCH`: solo una fecha nueva quita `snoozedUntil`; `{status: 'active'}` reabre uno hecho (`business_reminder.reopened`).
- `POST /business-reminders/templates/:key/apply`: 409 `template_already_applied`.
- `PATCH /business-reminders/settings` y el enlace del calendario: 403 `requires_all_facilities` a quien solo ve unos locales (y `GET` no le da `icsUrl`).
- Registro de actividad: `business_reminder.created|updated|reopened|completed|snoozed|deleted|settings_changed|calendar_link_created|calendar_link_revoked`.

### Operaciones diarias: mejoras (2026-11-14)

**Fotos y documentos** (tareas, incidencias, vencimientos; JPG, PNG, WebP o PDF, hasta 10 por registro, 10 MB cada uno)

- `POST /tasks/:id/photos/upload-url {mimeType}` → URL firmada; `POST /tasks/:id/photos {key, mimeType, filename}` (bytes comprobados, carpeta del registro; 400 `invalid_attachment`, `too_many_files`); `DELETE /tasks/:id/photos/:fileId`. Igual en `/incidents/:id/photos` y en `/business-reminders/:id/attachments` (+ `GET …/attachments/:fileId` → `{url}`). Las fichas devuelven las fotos con URL firmada; las listas, sin URL.
- Área de clientes: `POST /portal/me/incidents/photo-upload-url {mimeType}` y `POST /portal/me/incidents` con `photos` (hasta 4), `category` y `contractId` (uno de sus contratos vivos; 400 `contract_not_found`).

**Tareas**

- `GET /tasks` y `/tasks/page?due=overdue|today|week|none`. `GET /tasks/mine-count` → `{pending}` (mías, abiertas o en curso, atrasadas o de hoy).
- `TaskDto` gana `photos`, `expenseId`, `estimatedCost` y `supplierId` (del plan que la creó).
- `POST /tasks/:id/expense {amount, supplierId?, vendor?, expenseDate?}` (`expenses:manage`) → `ExpenseDto` (mantenimiento, en el local de la tarea; 409 `expense_already_registered`).

**Mantenimiento**

- `CreateMaintenancePlanSchema`: `interval` también en los semanales (cada N semanas), `dayOfMonth` hasta 31 (31 = último día), `leadDays` 0-60, `estimatedCost`, `supplierId` (400 `supplier_not_found`). `MaintenancePlanDto` gana `leadDays`, `estimatedCost`, `supplierId`, `supplierName`.
- `GET /maintenance-plans/:id/history` (`tasks:read`) → `{items, total, done, onTimePct, overdueOpen}`. `POST /maintenance-plans/:id/copy {facilityIds}` (`tasks:manage`) → los planes creados (sin responsable).

**Calendario**

- Tipos nuevos `invoice_due` (`invoices:read`) y `document_expiring` (`facilities:read`).
- `GET /v1/public/reminders-calendar/:token?include=tasks,moves`: también las tareas con fecha y las entradas y salidas de inquilinos (sin las prórrogas automáticas).

**Vencimientos**

- `POST /business-reminders/:id/undo` (`reminders:manage`) → el vencimiento con `expenseKept` (true si el gasto no se pudo borrar); 400 `nothing_to_undo`.
- `GET /business-reminders/forecast?months=1..24` → `{months: [{month, items, total}], total}`. `GET /business-reminders/due-count` → `{due}`.
- `POST /business-reminders/:id/task {title?, assignedToUserId?, dueDate?}` (`tasks:write`) → `TaskDto` (409 `reminder_task_exists` si hay una abierta para esa fecha). `BusinessReminderDto.attachments`.

**Incidencias**

- `category` (`IncidentCategoryEnum`), `cost`, `insuranceClaimStatus` (`filed|accepted|rejected|paid`), `insuranceClaimRef`, `insuranceClaimAmount` en alta y edición. `IncidentDto` gana `category`, `photos`, `responseDueAt`, `firstResponseAt`, `responseOverdue`, `cost`, `expenseId` y los del seguro.
- `GET|PUT /incidents/settings` (`incidents:read` / `incidents:manage`) → horas de la primera respuesta por gravedad (`IncidentResponseHoursSchema`, 1-720). La primera respuesta es un comentario, moverla de «reportada» o contestar al inquilino.
- `GET /incidents/page?category=&responseOverdue=1`.
- `POST /incidents/:id/transition`: resolver o descartar exige `resolution` (400 `resolution_required`).
- `POST /incidents/:id/reply {body}` (`incidents:write`, 204): al chat del inquilino y a los comentarios (400 `incident_without_customer`).
- `POST /incidents/:id/task` (`tasks:write`) → tarea de reparación (`metadata.incidentId`); `GET /incidents/:id/tasks`.
- `POST /incidents/:id/expense {amount, supplierId?}` (`expenses:manage`) → `ExpenseDto`; guarda `cost` y `expenseId` (409 `expense_already_registered`).
- `GET /incidents/report?from=&to=` (por defecto 90 días) → totales, horas hasta resolver, % respondidas a tiempo, coste, partes al seguro y desglose por tipo, gravedad y local.

### Leads, Seguimientos y Oportunidades: revisión (2026-11-15)

- **Alcance por local**: `/leads/*`, `/leads/followups/*`, `/leads/duplicates`, `/leads/response-stats` y `/followups` aplican el alcance del usuario. Quien solo ve unos locales ve los contactos de esos locales y los que no tienen local. Un contacto fuera de su alcance da 404; un seguimiento de un inquilino que no ve, también.
- `GET /leads` y `/leads/page`:
  - `status` inválido → 400 `invalid_status`;
  - `assignedToUserId` admite `me` (los míos) y `none` (sin responsable); cualquier otro valor que no sea un uuid → 400 `invalid_user`;
  - `search` busca por palabras.
- `POST /leads` y `PATCH /leads/:id`:
  - local, tamaño y responsable de otra empresa → 400 `facility_not_found`, `unit_type_not_found`, `user_not_found`;
  - en el `PATCH`, `''` o `null` vacían un campo (email, teléfono, local, tamaño, fecha, presupuesto, responsable…);
  - asignar a otra persona le manda el aviso `lead.assigned` solo a ella.
- Fechas (`preferredStartDate`, `dueDate` de seguimientos de contactos e inquilinos) con día real: `2026-13-45` → 400.
- `POST /leads/:id/transition`:
  - solo las fases de `LEAD_TRANSITIONS` (shared); el mensaje de error usa los nombres de las fases;
  - no pisa `contactedAt`;
  - pasar a perdido cancela los seguimientos pendientes (`status: 'cancelled'`).
- `POST /leads/:id/convert`:
  - la fila se bloquea (409 `lead_already_won` al segundo clic);
  - `customerId` de otra empresa o fuera de su alcance → 404;
  - copia la baja comercial y borra el motivo de pérdida;
  - emite `customer_created` si crea el inquilino.
- `POST /leads/:id/link-customer`: si ya estaba enlazado a otro inquilino → 409 `lead_already_linked`.
- `POST /leads/:id/activities`: fecha más de 5 min en el futuro → 400 `occurred_in_future`.
- `DELETE /leads/:id`: borra sus datos (los anonimiza y deja la fila para los recuentos).
- `GET|PUT /leads/settings` gana `retentionMonths` (3-60): meses que se guardan los perdidos sin actividad.
- `LeadDto` gana `bookedAt` (reserva online hecha, sin firmar todavía) y `returnedAt` (volvió a escribir y aún no se le ha atendido).
- Seguimientos (`LeadFollowupDto`, `CustomerFollowupDto`): `status` puede ser `cancelled`.
- `GET /opportunities/draft`: `customerId` que no sea un uuid → 400.
- `POST /opportunities/propose`:
  - gana `channel: 'email' | 'whatsapp'`: con `whatsapp` no se envía correo, solo se registra;
  - la misma propuesta en menos de 10 min → 409 `already_proposed`.
- `OpportunityDto.lastProposedAt` incluye las registradas por WhatsApp.

### Leads, Seguimientos y Oportunidades: mejoras (2026-11-15)

- `GET /leads`, `/leads/page` y `/leads/summary` ganan `facilityId` (o `none`: sin local) y `from`/`to` (YYYY-MM-DD, día de llegada). Local que no es un uuid → 400 `invalid_facility`; fecha imposible → 400 `invalid_date`.
- `GET /leads/summary` (`leads:read`) → `{byStatus: {<fase>: {count, value}}}`. `value` es lo que sumarían al mes: el presupuesto del contacto o el precio del tamaño que busca.
- `GET /leads/report?from=&to=` (`leads:read`, como mucho dos años; si no, 400 `invalid_range`) → embudo de los que llegaron en el periodo (`totals`, `bySource`, `byUser`, `byFacility`): contactos, atendidos, cualificados, ganados, perdidos, conversión y días medios hasta ganar.
- `GET /leads/:id/timeline` (`leads:read`) → `LeadTimelineItemDto[]`, del más reciente al más antiguo. Tipos: `created`, `email_out` (con su entrega en `status`), `email_in`, `whatsapp_in`, `whatsapp_out`, `webchat_in`, `webchat_out`, `activity`, `quote`, `visit`, `status` y `followup`.
- `GET /leads/:id/quotes` (`leads:read`) → presupuestos enviados (canal, local, tamaño, meses, cupón, total, quién, recordatorio y si acabó en reserva).
- `POST /leads/:id/quote/send` gana:
  - `channel: 'email' | 'whatsapp'` (por defecto `email`). Con `whatsapp` no sale correo: la respuesta trae `whatsappText` para mandarlo desde el móvil y queda registrado;
  - `followupInDays` (0-30, por defecto 3): crea el seguimiento «Llamar: ¿ha visto el presupuesto?» para quien lo envía.
  - La respuesta es `{sentTo, whatsappText, followupId}`.
- Visitas:
  - `GET /leads/:id/visits` (`leads:read`);
  - `POST /leads/:id/visits {scheduledAt, facilityId?, notes?, userId?}` (`leads:write`): el contacto pasa a cualificado;
  - `PATCH /leads/visits/:visitId {status?, scheduledAt?, notes?, userId?}`: con `status: 'done'` crea un seguimiento para el día siguiente;
  - `DELETE /leads/visits/:visitId`;
  - el calendario gana el tipo `lead_visit` (con `leads:read`).
- `GET|PUT /leads/settings` ganan `nurtureEnabled`, `useBusinessHours` y `quoteReminderDays` (0-30). `GET` añade `businessHoursConfigured`.
- Respuestas de los contactos: los correos a un contacto (respuesta, presupuesto y sus recordatorios) llevan `replyTo: l-<token>@<INBOUND_EMAIL_DOMAIN>`. `POST /webhooks/email-inbound` a esa dirección guarda la respuesta en su actividad (`type: 'email_in'`) y avisa a su responsable (`lead.reply`).
- Seguimientos (contactos e inquilinos):
  - `POST /leads/:id/followups` y `POST /customers/:id/followups` ganan `assignedToUserId`;
  - `PATCH /leads/followups/:id` y `PATCH /followups/:id` admiten `status`, `outcome`, `dueDate`, `title`, `note` y `assignedToUserId` (al menos uno). Al marcarlo hecho, el resultado queda en la actividad del contacto o en las conversaciones del inquilino. Responsable de fuera del equipo → 400 `user_not_found`;
  - los DTO ganan `assignedToUserId`, `assignedToName` y `outcome`.
- `GET /followups/inbox?tab=today|overdue|upcoming|done&mine=1` → `{items, counts}`: inquilinos (con `customers:read`) y contactos (con `leads:read`) juntos. «Hechos» = los 30 últimos días. «Míos» = asignados a mí, o creados por mí sin responsable.
- `GET /followups/due-count` → `{due}`: hoy y atrasados (número del menú).
- Importación: `GET /imports/leads/template`, `POST /imports/leads/preview` y `POST /imports/leads/commit` (`imports:manage` y `leads:write`). Columnas: nombre, apellidos, empresa, email, teléfono, origen, local, tamaño, estado (nuevo, contactado, cualificado o perdido), presupuesto, mensaje y fecha. El mismo email o teléfono que otro contacto abierto cuenta como repetido.
- Oportunidades:
  - tipos nuevos `annual_prepay`, `renewal`, `incomplete_data`, `google_review`, `referral` y `smaller_unit`;
  - `OpportunityDto` gana `facilityIds`. Los que han dicho «Me interesa» salen primero;
  - `POST /opportunities/dismiss {customerId, kind, days|null, reason?}` (`customers:write`, 204): pospone o descarta;
  - `DELETE /opportunities/dismiss?customerId=&kind=`: la recupera;
  - `GET /opportunities/dismissed` → las pospuestas o descartadas vigentes;
  - `POST /opportunities/propose-bulk {items: [{customerId, kind}], followupInDays}` (`communications:send`, hasta 100) → `{sent, skipped: [{customerId, kind, reason}]}`. Solo por correo; quien no tiene email se salta;
  - `GET /opportunities/results?days=` → por tipo: propuestas, vistas, «me interesa», contratadas, «no, gracias» e ingreso mensual nuevo;
  - `GET /opportunities/interested-count` → `{interested}`;
  - `kind` inválido en `draft` o `dismiss` → 400 `invalid_kind` (antes 500).
- Área de clientes: `PortalOfferDto` gana `url` (enlace externo, p. ej. la reseña en Google).

### Ampliar el plazo para firmar y pagar (2026-11-15)

- `POST /contracts/:id/payment-deadline {days | until, reason?, notifyCustomer}` (`contracts:write`) → `{paymentDeadline, notified}`:
  - `days`: de 1 a 30, contados desde el plazo actual (o desde ahora si ya venció);
  - `until`: YYYY-MM-DD, hasta el final de ese día en la hora del local. Hay que mandar uno de los dos;
  - `notifyCustomer` (por defecto `true`): correo «Te guardamos el trastero hasta el…» (`source: booking.deadline_extended`) con el enlace para firmar o pagar.
  - Errores:
    - sin plazo → 409 `no_payment_deadline`;
    - contrato cerrado → 409 `payment_deadline_closed`;
    - ya pagado → 409 `already_paid`;
    - fecha no posterior al plazo actual → 400 `deadline_not_later`;
    - más de 30 días desde la reserva o la firma → 400 `deadline_too_far`.
  - Queda en el historial (`note_added`, `event: payment_deadline_extended`) y en el registro (`contract.payment_deadline_extended`).
- `GET /contracts/:id/signing` gana:
  - `paymentDeadline`: el plazo, también si ya venció y la reserva aún no se ha cancelado;
  - `paymentDeadlineMax`: hasta cuándo se puede ampliar (`null` = no se puede).

### Campañas y Comunicaciones: revisión (2026-11-16)

- `POST /campaigns`, `PATCH /campaigns/:id`, `POST /campaigns/preview-email`, `POST|PATCH /campaigns/templates…` y `PATCH /campaigns/winback-settings` comprueban las variables del asunto y el mensaje → 400 `invalid_template_text` (`details.problems`). Variables: inquilinos `customer.firstName|lastName|displayName`, `tenant.name`; contactos `lead.firstName|displayName`, `tenant.name`; segundo aviso del win-back, además `coupon.code` (shared `templateTextProblems`, `CAMPAIGN_TEMPLATE_VARIABLES`).
- `POST /campaigns` y `PATCH /campaigns/:id`: `scheduledFor` en el pasado → 400 `scheduled_in_past`.
- `PATCH /campaigns/:id` (`communications:send`): cambia un borrador → 409 `campaign_not_editable` si no lo es.
- `POST /campaigns/:id/duplicate` → borrador nuevo «(copia)» sin fecha.
- `DELETE /campaigns/:id` → 204; solo borradores o canceladas (409 `campaign_not_deletable`).
- `POST /campaigns/:id/send`: sin destinatarios → 400 `campaign_no_recipients`.
- Alcance por local: quien solo ve unos locales solo ve las campañas que creó alguien con esos locales (404 las demás); su audiencia se limita a sus locales; un `segment.facilityId` de otro local → 403 `facility_not_in_scope`.
- `PATCH /campaigns/winback-settings`, `POST /campaigns/winback/run` y `GET /campaigns/winback/preview` (`{firstStep, secondStep}`) exigen `automations:manage` y ver todos los locales (403 `facility_not_in_scope`).
- `POST /campaigns/templates` y `PATCH …/:id`: nombre repetido → 409 `campaign_template_name_taken`.
- `GET /campaigns/:id/results`: las bajas se cuentan en la última campaña recibida; si la limpieza borró los envíos, devuelve los resultados guardados.
- `GET /communications`, `/communications/page`, `/communications/:id` y `POST /communications/:id/retry` respetan el alcance por local (404 fuera de él). `status` o `channel` no válidos → 400 `invalid_status` / `invalid_channel`; `customerId`/`leadId` no UUID → 400 `invalid_id`. `CommunicationDto.campaignName` (si el envío es de una campaña).

### Campañas y Comunicaciones: mejoras (2026-11-16)

- **Formato del mensaje** (campañas, win-back, automáticas): `**negrita**`, `[texto](https://…)`, una línea `[[boton: Texto | https://…]]` y direcciones sueltas. El correo los convierte (botón con el color de la marca); el texto plano lleva «texto (dirección)» y «Texto: dirección» (shared `campaignMarkupToText`, `campaignMarkupToHtml`).
- `POST /campaigns`: `channel` `email` (por defecto) o `whatsapp`; `subjectEn`/`bodyTextEn` (los dos o ninguno → 400 `english_version_incomplete`; los inquilinos con `locale: 'en'` reciben esa versión); `couponCode` (cupón activo del negocio → 400 `coupon_not_found`; habilita la variable `{{coupon.code}}`); `whatsappTemplate {name, language, params}` (obligatorio por WhatsApp → 400 `whatsapp_template_required`; sin WhatsApp Business activo → 400 `whatsapp_not_configured`). `PATCH /campaigns/:id` admite los mismos (salvo el canal; `''` quita la versión en inglés o el cupón).
- `CampaignDto` gana `channel`, `subjectEn`, `bodyTextEn`, `couponCode`, `whatsappTemplate`, `createdByName`.
- **Segmento** de inquilinos: `minMonths`/`maxMonths` (antigüedad desde el primer contrato firmado), `unitTypeId` (tamaño alquilado), `withoutInsurance`, `endingWithinDays`, `locale` (`es`|`en`), `excludeDebtors`; de contactos: `createdWithinDays`; los dos: `excludeRecentDays` (sin quien recibió otra comunicación comercial en esos días).
- `POST /campaigns/preview {segment, channel?}` → `{audienceCount, recentlyContacted, english}` (`recentlyContacted`: recibieron otra comercial en 7 días).
- **Programadas**: `POST /campaigns/:id/send` con fecha futura la deja `scheduled` sin preparar los envíos; el cron `campaigns.resume` (cada 5 min) calcula la audiencia al llegar la hora y la envía.
- `POST /campaigns/test-send {subject, bodyText, audience, couponCode?, english?}` (`communications:send`, 10/min) → `{sentTo}`: el correo de ejemplo al usuario, con «[Prueba]» delante del asunto.
- `GET|POST /campaigns/segments`, `DELETE /campaigns/segments/:id` (`communications:read`/`send`): segmentos guardados del equipo; nombre repetido → 409 `campaign_segment_name_taken`.
- `GET /campaigns/:id/results` gana `conversions {windowDays: 30, contracts, monthlyRevenue, leadsWon, couponUses}`.
- `GET /campaigns/:id/recipients?filter=clicked|bounced|unsubscribed|converted|failed` → `[{recipient, name, customerId, leadId, detail}]` (400 `invalid_filter`).
- `GET /campaigns/automations` y `PUT /campaigns/automations/:kind` (`anniversary`|`cold_leads`; `{enabled?, subject?, bodyText?, days?}`; `automations:manage` y ver todos los locales) → lista con `sentLast30Days`. Cron `campaigns.automations` (09:30, `claimDailyCronRun`). Origen de los envíos `campaign_auto.<tipo>`.
- **Comunicaciones**: `GET /communications/page` acepta `sourceGroup` (`campaigns`|`billing`|`contracts`|`sales`|`messages`; 400 `invalid_source_group`) y `facilityId`; `GET /communications/stats` (mismos filtros) → `{total, sent, delivered, bounced, failed, skipped, pending}`; `GET /communications/export` (CSV, hasta 5.000); `GET /communications/:id/preview` → `{html}` (el correo con la marca, enlaces con código tapados); `POST /communications/:id/cancel` (`communications:send`) → `skipped` («Cancelado por …»; 409 `communication_not_cancellable` si ya salió); `GET /communications/problem-addresses` → inquilinos y contactos cuyas direcciones rebotan, no existen, las bloquea su proveedor o marcaron spam.

### Fianzas: servicio pagado con la fianza y depósito de trasteros (2026-11-16)

- `POST /contracts/:id/settle-deposit` admite `serviceCharge {description, amount}`: parte de lo retenido que paga un servicio (importe con IVA incluido; 400 `service_charge_too_high` si pasa de lo retenido). Se emite una factura F1 con IVA 21 % (`taxCategory: S1`) y se paga con la fianza (`methodType: 'deposit'`, no cuenta en la caja). La factura se emite antes de tocar la fianza: si falla (sin datos fiscales, sin serie), el borrador se anula sin número y la fianza queda como estaba. Con servicio, el motivo de la retención es opcional (vale la descripción) y `applyToInvoices` aplica lo que queda a las facturas pendientes. `ContractDto.depositServiceInvoice {id, number, total}` (número y total solo en la ficha). El correo de la liquidación (`deposit_settled`) y el historial (`deposit_settled` con `serviceInvoiceNumber`/`serviceAmount`) la mencionan.
- `GET|PATCH /settings/tenant/contract-template`: `depositRegistryStorage` (depositar también las fianzas de trasteros; por defecto no). Con él, `PUT /contracts/:id/deposit-registry` acepta trasteros (si no, 400 `not_housing`) y «Hoy» (`depositsToRegister`) los incluye.

### Fidelización: revisión (2026-11-16)

- **Promociones**: `PromotionDto.announceOnWeb` (y en `POST`/`PATCH /promotions`): se anuncia en la web pública y su código vale en la reserva online. `PATCH /promotions/:id` comprueba el resultado → 400 `invalid_promotion` (porcentaje > 100, meses gratis no enteros, fin anterior al inicio). `DELETE /promotions/:id` de una ya usada → 409 `promotion_in_use`. `GET /promotions` no incluye las ofertas de un trastero ni los códigos antiguos de referidos. `POST /promotions/validate` admite `billingIntervalMonths`; motivos nuevos `not_for_unit` y `not_with_prepay`. `POST /contracts` con una promoción de meses gratis y pago semestral o anual → 400 `promotion_not_with_prepay`.
- **Alcance**: `POST|PATCH|DELETE /promotions` y `/coupons` → 403 `facility_scope_restricted` a quien solo ve unos locales. `POST /promotions/unit-offers` y `DELETE …/:unitId` → 403 `facility_not_in_scope` fuera de sus locales.
- **Reserva online**: `couponCode` de `POST /public/move-in/book/:slug` y `…/quote` admite también el código de una promoción anunciada en la web. `FirstPaymentQuoteDto.promotion {code, name, listPrice, monthlyDiscount, freeMonths}` (también en `GET /public/move-in/sign/:token`); `monthlyPrice` ya la lleva descontada. `BookingAvailabilityDto.referralEnabled`.
- **Referidos**: la recompensa se concede cuando el recomendado paga su primera factura. `ReferralDto` gana `referrerActive` y `reward.appliedAmount`; estado `cancelled` = no llegó a ser cliente. `GET /referrals` y `/referrals/stats` respetan el alcance por local. `GET /referrals/customers/:customerId/code` (`referrals:read`) → `{enabled, referralCode}`. `PATCH /settings/tenant/referrals`: porcentaje > 100 → 400.
- **Valoraciones**: `POST /reviews/request` → 400 `customer_without_email`/`customer_without_phone`, 409 `review_recently_requested`, 404 fuera de alcance. `POST /reviews/:id/resend` (`reviews:write`) → `ReviewDto`; 400 `review_already_submitted`, 409 `review_recently_requested`. `PATCH /reviews/:id/web` exige `reviews:write` y el permiso del autor (400 `review_without_consent`). `GET /reviews?status=pending|expired` cuenta la fecha del enlace; `ReviewDto` gana `publishConsent` y `reviewUrl`. `POST /public/reviews/:token` admite `publishConsent`; un segundo envío → 404 `review_not_pending`.
- Avisos nuevos: `referral.converted` y `review.low_score` (este también al móvil).

### Fidelización: mejoras (2026-11-16)

- **Promociones**: `PromotionDto` y `POST`/`PATCH /promotions` ganan `durationMonths` (1-36; null = todo el contrato; no con meses gratis), `unitTypeIds`, `facilityIds`, `newCustomersOnly` y `oncePerCustomer`. `PATCH` de una ya usada no cambia tipo ni valor → 409 `promotion_discount_locked`; tipos o locales que no existen → 400 `invalid_scope`. `POST /promotions/validate` admite `customerId` y da los motivos `unit_type`, `facility`, `new_customers_only`, `already_used` y `duration_too_short`; con duración devuelve `durationMonths`. Al crear el contrato: 409 `promotion_<motivo>` y 400 `promotion_duration_too_short` (pago por adelantado de más meses de los que dura). `GET /promotions/:id/results` (`promotions:read`) → `PromotionResultsDto {contracts[], liveContracts, monthlyCost, monthlyRevenue}`.
- **Cupones**: `CouponDto` gana `announceOnWeb`, `kind` (`standard`|`personal`) y `personalFor`. `POST /coupons/personal {personalFor, discountType, discountValue, validDays, minMonths}` (`promotions:manage`) → cupón de un uso con el código puesto por el sistema. `GET /coupons/:id/results` → `CouponResultsDto {uses, totalDiscount, liveContracts, monthlyRevenue}`. `GET`/`PUT /coupons/settings {bookingRecoveryCouponPct, bookingRecoveryCouponDays}`: cupón personal que acompaña al recordatorio de una reserva sin terminar (0 % = ninguno).
- **Web pública**: `PublicLandingDto.activePromotion` puede ser un cupón anunciado: `kind` (`promotion`|`coupon`), `minMonths` (cupón) y `durationMonths` (promoción).
- **Referidos**: `PATCH /settings/tenant/referrals` admite `referralFriendRewardType` (`percentage`|`fixed`|null), `referralFriendRewardValue` y `referralMaxRewardsPerYear` (null = sin tope). `POST /public/move-in/book/:slug/quote` y la reserva aplican el descuento del recomendado cuando llega un `referralCode` válido y ningún otro código: `FirstPaymentQuoteDto.referralFriend: true`. `GET /referrals/customers/:customerId/code` añade `shareUrl`. `ReferralDto.rewardSkippedReason` (`yearly_cap`). `GET /referrals/top` (`referrals:read`) → `ReferralTopDto[]`. `GET /portal/me/referrals` añade `shareUrl`, `reward` y `friendReward`.
- **Valoraciones**: `GET /reviews/stats?months=&facilityId=` y `GET /reviews/insights?months=&facilityId=` (`reviews:read`) → `ReviewInsightsDto {trend[], byFacility[]}`. `ReviewDto` gana `exit`, `exitReason` y `remindedAt`. `GET /public/reviews/:token` → `exit`; `POST /public/reviews/:token` admite `exitReason` (solo se guarda en la encuesta de salida) y devuelve `referral {code, shareUrl, reward, friendReward}` a quien puntúa con 9 o 10. `PATCH /settings/tenant/reviews` admite `reviewsReminderEnabled` y `reviewsYearlyEnabled`.
- **Analítica**: `GET /analytics/exit-reasons?months=&facilityId=` → `ExitReasonsDto {sent, answered, nps, reasons[]}`.
- **Tareas automáticas**: `GET`/`PUT /tasks/auto-rules` gana `lowReview {enabled, days}`.

### Primer pago pendiente (2026-11-16)

- Correo nuevo al inquilino `first_payment_pending` (`customer_email.first_payment_pending` en Comunicaciones; `GET`/`PATCH /settings/tenant/customer-emails` admite `first_payment_pending`): al firmar por enlace con el primer pago por hacer, con el desglose, el total, el plazo y el enlace de la firma para pagar. Sustituye al de `contract_signed` en ese caso.
- Evento interno `domain.first_payment_pending {tenantId, contractId, payUrl}` (no es disparador de automatizaciones). `domain.contract_signed` lleva `scope.awaitingFirstPayment` cuando se firma por enlace.
- `GET /customers/:id/account` → `firstPayment {invoiceId, amount, deadline} | null`: factura sin emitir y fianza que van juntas, con el plazo para pagarlas.
- Tras firmar por enlace, el enlace de la firma vale hasta el plazo para pagar.

### Primer pago en PDF y reenvío (2026-11-16)

- `GET /v1/public/invoices/:token/pdf` (enlace sin sesión del correo): con la factura del primer pago aún sin emitir, devuelve directamente el PDF de su detalle (sin número, con la fianza y el total a pagar; no se guarda). Pagada, lleva como siempre a la factura emitida. El justificante de fianza sin emitir da el mismo detalle.
- `GET /invoices/:id/signed-pdf` y `GET /portal/me/invoices/:id/signed-pdf`: para el primer pago sin emitir, `url` es ese enlace. En el área de clientes, `hasPdf` es `true` para el primer pago.
- `POST /invoices/:id/send` (también con el id de la fianza): para el primer pago sin emitir reenvía el correo del primer pago con el PDF y un enlace nuevo para pagar (el anterior deja de valer). Sale aunque el aviso automático esté apagado; queda en Comunicaciones como `invoice.sent`. Con el plazo vencido: 409 `payment_deadline_passed`; sin nada pendiente: 400 `nothing_to_pay`.
- El correo `first_payment_pending` lleva el enlace del PDF.
- `POST /contracts/:id/payment-deadline` alarga también el enlace para pagar de un contrato ya firmado.

### Marketing: seguridad y atribución (2026-11-16)

- **Google Analytics** (`PUT /marketing/ga4 {propertyId}`): antes de guardar nada comprueba que la propiedad es de la web del negocio. 400 `ga4_measurement_id_required` (sin ID de medición en Marca y SEO), 400 `ga4_measurement_id_shared` (ese `G-…` lo tiene otro negocio), 400 `ga4_property_mismatch` (ningún flujo web de la propiedad tiene ese ID; lo lee de la Admin API de Google Analytics, `properties/{id}/dataStreams`), 400 `ga4_property_unverified` (no se pudo consultar) y 409 `ga4_property_taken` (la propiedad está en otro negocio; índice único). `ga4_no_access` ya no guarda la conexión: el motivo va en el `message`. Las conexiones anteriores se comprueban en la siguiente descarga (`tenant_ga4.verified_at`): si no miden la web, quedan en `error` con el motivo y no se descarga nada. Las páginas de firma llegan como `/sign/enlace`, sin el enlace secreto. Simulado: la propiedad `N` mide `G-N`.
- **Search Console** (`PUT /seo/search-console {siteUrl}`): solo el dominio propio verificado (`sc-domain:` de ese dominio o de uno superior, o una dirección suya) o la dirección del negocio en la plataforma (`<WEB_BASE_URL>/s/<identificador>/`) → 400 `search_console_site_not_yours`; un sitio conectado en otro negocio → 409 `search_console_site_taken`. Una conexión anterior que no cumpla se para en la siguiente descarga.
- **Canales**: cada contacto, visita o reserva va a un canal como mucho: primero por `utm_campaign` (el id del canal o su campaña en Google Ads o Meta), después por el origen. Google Ads y Meta Ads solo recogen el tráfico de pago de su origen (`utm_medium` `cpc`, `paid_social`, `display`…); el resto, su origen con cualquier medio. `utmSourceMatch` admite varios orígenes separados por comas; si se deja vacío al crear: `google` (Google Ads), `facebook, instagram` (Meta Ads), el portal reconocido por el nombre o la dirección (Idealista, Fotocasa, Habitaclia…) o el nombre. `MarketingChannelDto.sourceConflictWith`: otro canal del mismo tipo (de anuncios o no) que recoge el mismo origen; sus contactos van al activo más antiguo.
- **Visitas y resumen**: `WebAnalyticsSourceDto` y `MarketingSummarySourceDto` ganan `paidTraffic` (fila aparte para el tráfico de pago del mismo origen). Los anuncios de Facebook e Instagram van juntos como `meta`; el gasto de un canal de anuncios va a su fila de pago.
- **Chat de la web**: topes por IP (sin guardarla) y día en cada negocio: 10 conversaciones nuevas, mensajes = el tope por visitante × 3 (mínimo 30), 3 pasos a una persona y 2 reservas; y 200 respuestas de la IA por negocio y hora. Al pasarse, la respuesta llega con `limited` y sin gastar IA. `POST …/chat/handoff` sin ningún mensaje del visitante no avisa a nadie (`limited: 'tenant'`). El resumen al pasar a una persona gasta del límite del chat y espera como mucho 20 s. Las reservas desde el chat guardan la IP y el navegador como las de la web.
- **Anonimizar un negocio** (`POST /admin/tenants/:id/anonymize`) borra también las credenciales de Google Ads y Meta Ads, la conexión con Google Analytics y con Search Console, y lo descargado de los dos.
- **Anuncios**: Google Ads con la API v26 y Meta Ads con la v25.0 (las anteriores dejaron de funcionar), con tiempo máximo por petición; el token de Meta va en la cabecera `Authorization`. Las sincronizaciones diarias (anuncios, Google Analytics, Search Console) se saltan los negocios dados de baja.

### Marketing: revisión, fallos medios y menores (2026-11-16)

- **Chat de la web**:
  - `POST /public/landing/:slug/chat` admite `utmSource`/`utmMedium`/`utmCampaign` (el origen de la visita; la conversación lo guarda y sus reservas y contactos lo heredan) y devuelve `askContact` (pidió una persona fuera del horario del equipo: se le piden sus datos).
  - `POST /public/landing/:slug/chat/updates {visitorId, after?}` (20/min) → `{active, mode, staffMessages}`: consulta ligera del widget con la burbuja cerrada.
  - Panel: `GET /web-chat/conversations/:id/info` (`communications:read`; abre `?c=` aunque no esté en la lista), `POST /web-chat/conversations/:id/read` (`communications:send`; leído por persona) y `DELETE /web-chat/conversations/:id` (`marketing:manage`, derecho de supresión). Conversaciones, pendientes, mensajes y avisos piden `communications:read`/`:send`; los avisos solo llegan a quien puede leerlas.
  - `GET/PATCH /web-chat/settings` con `teamHours` (horario del equipo, `null` = siempre) y `ownKey`. `GET /web-chat/pending` añade `conversations` (lo que cuenta el menú). `WebChatRole` añade `system` (textos fijos, fuera de las cifras y del historial del modelo).
  - Una conversación esperando a una persona vuelve a la IA a los 15 minutos sin respuesta (y a los 2 días, en la limpieza); apagar el paso a una persona libera las que esperaban.
- **Visitas** (`GET /marketing/web-analytics`): `previousComplete` (sin datos de todo el periodo anterior no hay variación), `money` (`revenue`/`cost` según permisos; sin ellos, cobrado y gasto a 0) y totales `pendingSignature`/`signedUnpaid` (reservas que siguen en pie). Ingresos netos (sin IVA, fianza, compensaciones ni retención y menos devoluciones) y reservas por el origen de la visita en que se hicieron. `POST /public/landing/:slug/events`: tope de 1.500 eventos por IP y día y 50.000 por negocio, rutas válidas y nada de negocios suspendidos.
- **Google Analytics y redes**: `GET /marketing/ga4/report` y `GET /marketing/social/report` añaden `previousComplete`. Conectar, sincronizar y los informes piden Web Premium; ver la conexión y desconectar, no. Un error pasajero de Google da 502 `google_unavailable`. Conectar y quitar quedan en el registro de actividad (`marketing.ga4_connected`/`_disconnected`, `marketing.social_connected`/`_disconnected`).
- **Resumen** (`GET /marketing/summary`): `partial` (mes en curso: se compara con los mismos días del anterior), `previousComplete {web, ga4, social}`, `money` y en las cifras `pendingSignature`/`signedUnpaid`. Los consejos miran todos los orígenes. `POST /marketing/summary/report/send` queda en el registro (`marketing.summary_sent`). El correo mensual sale del día 4 al 10; si no hay a quién enviarlo o falla, se intenta al día siguiente.
- **Canales** (`/marketing/channels`):
  - `POST`/`PATCH`: 409 `external_campaign_taken` (la campaña ya está en otro canal), 400 `facility_not_found`/`promotion_not_found` (de otro negocio), `externalUrl` solo `http(s)`, `monthlyCost: null` lo borra y `renewalMonths` (1-36, la fecha de renovación avanza sola). Quien solo ve unos locales gestiona los canales de esos locales (403 `facility_scope_restricted` para los de todo el negocio).
  - `MarketingChannelDto` gana `renewalMonths`, `lastSyncAt`, `lastSyncError` y `syncFailingSince`; `monthlyCost` es `null` sin `expenses:read`.
  - Borrar un canal pausa sus gastos recurrentes; su gasto y sus clientes siguen en Rendimiento y su QR sigue llevando a la web.
- **Rendimiento** (`GET /marketing/channels/performance`): 400 `invalid_date`; días en la zona del negocio; clientes = contratos firmados en el periodo (sin cancelar) de contactos del canal o con su promoción; filas `deleted` y `liveCount`; `unassignedCost` (marketing sin canal); `money`. Sin `expenses:read` el coste sale a 0 y los costes a `null`; sin `invoices:read` y `payments:read`, la cuota a 0.
- **Anuncios** (`GET /marketing/channels/ads-performance`): mismos criterios (reservas online que siguen en pie), gasto de los días sin métricas desde los gastos vinculados y `money`.
- **Sincronización del gasto** (`POST /marketing/channels/:id/sync-ad-spend`): sin fechas, desde unos días antes del último con datos (90 la primera vez); con fechas, como mucho 90 días (400 `sync_range_too_long`, `invalid_range`). Una cuenta que no esté en euros falla con el motivo.
- **Credenciales de anuncios**: `DELETE /settings/marketing/google-ads` y `DELETE /settings/marketing/meta-ads` (`marketing:manage`) las borran; «Probar conexión» funciona antes de activar. Los cambios quedan en el registro (`marketing.<plataforma>_settings_changed`/`_deleted`, solo los nombres de los campos).
- **Enlace corto** (`GET /public/marketing/go/:shortCode`): un canal pausado, finalizado o borrado redirige sin contar; un negocio de baja da 404. No cuentan los robots, las vistas previas de WhatsApp o Facebook, `count=0` (lo manda el web en las peticiones HEAD) ni el mismo visitante dos veces en 30 minutos (el servidor del web pasa su IP y su navegador en `x-visitor-ip`/`x-visitor-ua`, solo con el token interno). `utm_medium` según el tipo de canal.
- **Catálogo** (`GET /marketing/catalog-feed`): textos sin fórmulas de Excel, coma decimal y enlace a la reserva con el local y el tamaño (en el dominio propio, `/reservar/<local>`); 400 `invalid_facility_id`; respeta el alcance por local.
- **Exportar los datos del negocio**: hojas nuevas «Chat de la web» y «Canales de marketing». **Vaciar los datos de prueba** borra también los chats de la web sin contacto y las métricas de los anuncios.

### Marketing: mejoras (2026-11-16)

- **Canales** (`/marketing/channels`):
  - `GET ?facilityId=` filtra por local. `POST`/`PATCH` aceptan `couponId` (400 `coupon_not_found` si no es del negocio; los contratos con ese cupón cuentan para el canal) y `monthlyBudget` (`null` lo quita).
  - `MarketingChannelDto` gana `couponId`, `couponCode`, `trackingUrl` (la web con `utm_source`, `utm_medium` y `utm_campaign` = id del canal), `monthlyBudget` y `spentThisMonth` (estos dos, `null` sin `expenses:read`).
  - Códigos cortos nuevos: 6 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. `GET /public/marketing/go/:shortCode` también los encuentra escritos en minúsculas.
  - `GET /marketing/channels/unassigned-sources?days=30|90|365` (`marketing:read`) → `MarketingUnassignedSourceDto[]`: orígenes con visitas, contactos o reservas que no recoge ningún canal, con el tipo y el nombre que se proponen.
  - El contacto guarda su canal al llegar (`leads.marketing_channel_id`, también cuando una reserva le pone su primer origen): los informes lo usan antes que el origen.
- **Rendimiento** (`GET /marketing/channels/performance?model=first|last&facilityId=`): `model` = canal del primer contacto (por defecto) o de la visita en que reservó; 400 `invalid_model` e `invalid_facility_id`. Cada fila gana `visitors`, `bookings` (reservas online que siguen en pie), `paidCount`, `collected` (cobrado sin IVA y menos devoluciones; 0 sin permiso) y `roas` (cobrado ÷ coste); la respuesta, `model` y `facilityId`.
- **Avisos** (tarea `marketing-budgets.daily`, 9:30): `marketing.channel_over_budget` (lo gastado en el mes pasa del presupuesto) y, desde el día 15, `marketing.channel_no_results` (gasto y ninguna reserva ni cliente); uno de cada por canal y mes, a quien tiene `marketing:read`. El aviso de renovación dice los contactos y clientes de los últimos 90 días.
- **Conversiones a Google Ads y Meta**:
  - `PUT /settings/marketing/google-ads` acepta `conversionActionId` y `PUT /settings/marketing/meta-ads`, `pixelId` (solo cifras; `''` lo quita). Los dos DTO ganan `conversions {sent, failed, lastError, lastSentAt}`. Guardar los ajustes vuelve a intentar los envíos fallidos.
  - `clickIds {gclid?, gbraid?, wbraid?, fbclid?, at?}` en `POST /public/move-in/book/:slug`, `…/book/:slug/lead`, `POST /public/landing/:slug/contact`, el formulario de las landings y `…/chat/book`; el web solo los manda con «Aceptar todas» las cookies. `PublicLandingDto`, `PublicFacilityLandingDto` y `BookingAvailabilityDto` ganan `adConversions` (el negocio las tiene activadas: el aviso de cookies sale aunque no haya Google Analytics).
  - Tarea `marketing.ad-conversions` (cada 30 minutos, worker): los contratos firmados en los últimos 7 días de contactos con identificador de clic se envían una vez por contrato y plataforma (`ad_conversion_uploads`), con la cuota mensual sin IVA como valor. Google Ads: `uploadClickConversions` con el consentimiento `adUserData`. Meta: evento `Purchase` de la API de conversiones con email y teléfono en SHA-256. Simulado con `NODE_ENV=test` o `AD_CONVERSIONS_MODE=stub` (un identificador que empieza por `fail` falla).
- **Visitas** (`GET /marketing/web-analytics`): gana `newVisitors`, `returningVisitors`, `bookingFunnel {visitors, bookingPage, started, bookings, signed, paid}`, `contactHours` (clics en llamar y WhatsApp por día y hora en la zona del negocio), `demand` (visitas a la ficha de cada local y reservas empezadas por tamaño) y `annotations`; cada origen, `entryPath` (página por la que más entran). Se leen de tablas ya sumadas (`web_visits`, `web_page_daily`). `POST /public/landing/:slug/events` admite `booking_start` con `facilityId` y `unitTypeId` (solo locales y tamaños del negocio).
  - `POST /marketing/web-analytics/annotations {day, text}` (`marketing:manage`) → `MarketingAnnotationDto`; `DELETE /marketing/web-analytics/annotations/:id` (204; 404 `annotation_not_found`). Además de las escritas, salen solas los canales nuevos, el inicio de las promociones, las campañas enviadas y las publicaciones.
- **Resumen** (`GET /marketing/summary?facilityId=`): gana `lastYear` (mismo mes del año pasado), `lastYearComplete` y `facilityId`.
- **Redes** (`/marketing/social`): `GET` gana `oauthAvailable` (`META_APP_ID` y `META_APP_SECRET` configuradas).
  - `GET /marketing/social/oauth/start` (`marketing:manage`, Web Premium) → `{url}` de Meta con un `state` firmado (negocio, usuario y 15 minutos); 400 `social_oauth_unavailable`.
  - `GET /marketing/social/oauth/callback?code&state` (pública) → 302 a `/marketing/social?oauth=<clave>` (el token, cifrado 15 minutos en Redis) u `?oauth_error=state|cancelled|unavailable|exchange`.
  - `PUT /marketing/social {oauthKey, pageId?}` conecta con esa clave (una vez y solo del mismo negocio; si no, 400 `social_oauth_expired`).
  - El informe gana `dataUntil` y `postInsights` (formatos, mejor día y hora, clics al enlace y tasa de interacción); cada publicación, `linkClicks` (Facebook) y `engagementRate`.
- **Conexión rota**: si la descarga diaria de Google Analytics, Instagram y Facebook o Search Console falla, aviso `marketing.connection_broken` una vez; se puede volver a avisar cuando vuelva a fallar tras funcionar.
- **Chat de la web**:
  - `POST /public/landing/:slug/chat/book` (5/min): reserva con el formulario del chat, sin la IA (`PublicWebChatBookingSchema`: local, tamaño, fecha, datos del cliente, origen e identificadores de clic). Una reserva por conversación; la respuesta lleva el enlace de firma y el resumen del primer pago.
  - `POST /public/landing/:slug/chat/new {visitorId}` (10/min) → `{ok}`: la conversación anterior sigue en el panel y el siguiente mensaje abre otra. `…/chat/history` gana `bookingsEnabled`; `…/chat/contact` vale sin haber escrito antes.
  - Marcas nuevas del asistente: `[[VISITA {local, fecha, hora, nombre, email, telefono}]]` (guarda el contacto y la visita por confirmar en el calendario de contactos; aviso `web_chat.visit`) y `[[PRESUPUESTO {tipo, email, nombre}]]` (correo con el primer pago, la cuota y el enlace a la reserva; `source` `web_chat.quote`; 3 por IP y día). El asistente conoce las condiciones del negocio (fianza de cada tamaño, formas de pago, preaviso, protección del contenido y horario de acceso) y la guía de tamaños.
  - `POST /web-chat/try {message, history}` (`settings:manage`, `ai_assistant`, 20/min) → `{answer, actions}`: lo que respondería y lo que haría, sin guardar nada (gasta una respuesta del mes).
  - `PATCH /web-chat/conversations/:id {mode?, assignedToUserId?}`: responsable (alguien activo del equipo; 400 `user_not_found`) con aviso `web_chat.assigned` para esa persona. `WebChatConversationDto` gana `assignedToUserId` y `assignedToName`.
  - `GET /web-chat/stats` gana `paidBookings`, `revenue` (0 sin permiso), `visitsRequested` y `badlyRated` (las últimas respuestas con 👎 y su pregunta).
  - Avisos: `web_chat.weekly_ratings` (lunes, tarea `web-chat.weekly-ratings`) y `ai.web_chat_limit_near` (80 % de las respuestas del mes, una vez al mes).

### Comerciales (2026-11-16)

Perfil **Comercial** (`super_admins.role = 'sales'`) en el panel de administración. Detalle de uso en `docs/DEPLOYMENT.md §151`.

- **Acceso**: `AdminGuard` deniega a un comercial todo lo que no lleve `@SalesAccess()` (403 `sales_not_allowed`); solo tiene `/admin/auth/*`, `/admin/me/push*` y `/admin/sales/*`. La verificación en dos pasos le es obligatoria desde el primer día (403 `admin_two_factor_required` en sus pantallas hasta activarla; `GET /admin/auth/2fa/status` da `required: true` y `deadline: null`; `POST /admin/auth/2fa/disable` → 400 `two_factor_required_by_policy`), salvo que la dirección se la quite (`super_admins.sales_two_factor_exempt`, `PATCH /admin/sales-team/reps/:id {twoFactorRequired: false}`): entonces `required: false`, puede entrar sin ella y desactivarla, y no le alcanza la política general de 2FA del panel. Soporte no usa `/admin/sales/*` (403 `sales_only`) y `/admin/sales-team/*` es solo del rol superadmin. Un comercial nunca ve inquilinos ni facturación de sus clientes, ni puede entrar en su cuenta.
- **Super admins**: `POST /admin/super-admins` con `role: 'sales'` y `PATCH /admin/super-admins/:id/role` desde o hacia `sales` → 400 `sales_role_locked` (se gestionan en «Equipo comercial»). `SuperAdminDto.salesCode` en los comerciales.
- **Avisos personales**: `super_admin_notifications.recipient_id`. Los avisos con destinatario solo los ve (y le llegan al móvil) esa persona; el feed y el contador del panel de administración solo muestran los que no lo tienen. Tipos `sales.*` en `SUPER_ADMIN_PUSH_TYPES`.

**Público**

- `GET /public/sales/code/:code` (20/min) → `SalesCodeCheckDto {valid, repName, extraTrialDays}`. El código no distingue mayúsculas ni separadores (`normalizeSalesCode`).
- `GET /v1/public/offers/:id/open?sig=` (30/min) → 302 al enlace de la propuesta (registro con `?team=` o Suscripción del tenant). Con la firma correcta anota la primera apertura (`platform_quote_offers.opened_at`) y avisa al comercial (`sales.offer_opened`). Las propuestas valen 15 días (`expires_at`) y se recuerdan 3 días antes de caducar.
- `POST /auth/register` acepta `salesCode` y `salesCodeFrom` (`link` = enlace o QR; `typed` = escrito por el cliente); `POST /platform-contact` acepta `salesCode`. **Solo así, o si el comercial crea la cuenta, una cuenta es de un comercial**: sin código no se asigna a nadie. Con el código, la prueba suma `platform_sales_settings.signup_extra_trial_days`. Si el email era un prospecto de un comercial y se registra sin su código, queda pendiente de que la dirección decida.

**Comercial** (`/admin/sales`, solo `role = 'sales'`; todo se limita a su cartera, una cuenta de otro → 404)

- `GET/PATCH /me` → `SalesRepProfileDto` (código, enlaces, días de más y sus topes; cambia teléfono, WhatsApp y enlace de reservas).
- `GET /today` → `SalesTodayDto` (seguimientos, altas con su código, pruebas que acaban, pagos pendientes, pruebas sin arrancar, propuestas sin respuesta, sin contacto y cifras con su objetivo).
- `GET /leads?search=&status=&filter=no_contact|trial_ending|pending` → `SalesLeadListDto`. `POST /leads` (`CreateSalesProspectSchema`; email o teléfono ya existentes en cualquier contacto → 409 `lead_exists`, sin decir de quién es). `POST /leads/import {csv, commit}` (200) → `SalesImportResultDto` (repasa y, con `commit`, crea; los repetidos no se importan).
- `GET /accounts/:leadId` → `SalesAccountDto` (lead con actividad, seguimientos y propuestas; ficha; cuenta del cliente sin datos de sus inquilinos; cadencia; `pendingAssignment`). `PATCH /accounts/:leadId` (datos), `PUT …/profile` (`UpdateSalesProfileSchema`: nota fija, estado, temperatura, quién decide, mejor momento, siguiente paso), `POST …/outcome` (`SalesCallOutcomeSchema`: deja la actividad, la temperatura, la fase y el siguiente seguimiento), `POST …/move|lose|reopen|activities|followups|email|registration-link|create-tenant|quote|cadence`, `DELETE …/cadence`, `GET …/summary?ai=1` → `SalesAccountSummaryDto` (con IA si la plataforma la tiene). `PATCH/DELETE /followups/:id`.
- `create-tenant` (`SalesCreateTenantSchema`): la cuenta con la prueba estándar y en su cartera (`sales_source = 'created'`); el propietario recibe el correo para elegir su contraseña.
- `GET /clients?filter=trial|trial_ending|paying|past_due|onboarding|no_contact` → `SalesClientRowDto[]`. `POST /clients/:tenantId/extend-trial` (`SalesExtendTrialSchema`; pasado su tope por cliente → 403 `trial_extension_limit` con `details.remaining`). `POST /clients/:tenantId/addon-offer` (`SalesAddonOfferSchema`; `trial` = una prueba del extra por cliente, de los días que fije la dirección).
- `GET /catalog` (planes, extras y solo los cupones con `sales_allowed`), `POST /quote` (200; simulador; otro cupón → 403 `coupon_not_allowed`), `GET /offers`, `GET /opportunities` (las de sus clientes).
- `GET/POST /approvals` (`SalesApprovalRequestSchema`: cambio de plan, extra con precio especial o más días de prueba; va a la cola de aprobaciones de la dirección y avisa al comercial al decidirse, `sales.approval_decided`).
- `GET /claims`, `PUT /claims/:id/note {repNote}`, `GET /commissions` → `SalesCommissionsDto`, `POST /commissions/concepts` (`RequestSalesConceptSchema`: pide un concepto de su plan, queda por aprobar), `GET /settlements`, `GET /targets`.
- `GET /materials`, `GET /materials/:id/download` → `{url}`, `GET /templates`, `GET /cadences`, `GET /demo` → `SalesDemoStatusDto` (con `tenantSlug` para abrir su web `/s/<slug>`), `POST /demo/open` → sesión en la cuenta de demostración (sin solo lectura y sin avisar a nadie), `POST /demo/portal` → `SalesDemoPortalLinkDto {url, customerName}` (en esa área de clientes, `GET /portal/me/payments/options` trae `demoCard: true` y `POST /portal/me/invoices/:id/demo-card-payment` simula el pago con tarjeta sin pasarela; fuera de la demo, 403 `demo_only`): enlace de un solo uso al área de clientes de la inquilina de la demo (etiqueta `demo-portal`; 409 `demo_portal_missing` si falta: poner la demo a cero).
- `GET /notifications?cursor=&unread=1`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`.

**Dirección comercial** (`/admin/sales-team`, rol superadmin)

- `GET /` → `SalesTeamDto`; `GET /pending-count`; `GET /pending-assignments` → `SalesPendingAssignmentDto[]`; `POST /assign` (`AssignSalesAccountSchema`, `repId: null` = sin comercial).
- `POST /reps` (`CreateSalesRepSchema`; le llega el correo para elegir contraseña; código propio o generado; 409 si el código está cogido), `GET/PATCH /reps/:id` (`SalesRepSummaryDto.twoFactorRequired`; `twoFactorRequired` en el PATCH quita o vuelve a exigir la verificación en dos pasos, auditado `admin.sales.rep_two_factor_changed`), `GET /reps/:id/accounts`, `POST /reps/:id/reassign` (200, `ReassignSalesPortfolioSchema`). Desactivar o reactivar: `PATCH /admin/super-admins/:id/active`.
- `PUT /reps/:id/plan` (`UpdateSalesCommissionPlanSchema`), `POST/PATCH/DELETE /reps/:id/concepts[/:conceptId]`, `PUT /reps/:id/targets` (`UpsertSalesTargetSchema`).
- `GET /accounts?tenantId=|leadId=` → `SalesAccountRepDto` (comercial, origen, desde cuándo e historial).
- `GET /claims?status=`, `POST /claims/:id/approve|reject {note?}`; `GET /commissions?repId=&month=&status=`, `POST /commissions/items` (`CreateSalesCommissionItemSchema`: concepto o ajuste, ya aprobado), `POST /commissions/items/:id/approve|reject`, `POST /commissions/recalculate`; `GET /settlements?repId=`, `POST /settlements {repId, month}` (todo lo aprobado y sin liquidar hasta ese mes; se paga en efectivo, así que queda `paid` en el acto y no se avisa al comercial, que la ve en «Mis comisiones»; 400 si ya existe), `POST /settlements/:id/paid` (solo para alguna antigua pendiente; tampoco avisa).
- `GET/PUT /settings` (`UpdatePlatformSalesSettingsSchema`: días de más con el código, liberar prospectos sin actividad, días de prueba que amplía un comercial, días de prueba de un extra, correos automáticos de sus clientes con su nombre, puesta a cero nocturna de la demo).
- `POST /demo` (crea la cuenta de demostración, exenta y fuera de las cifras), `POST /demo/reset`, `POST /demo/open`, `POST /demo/portal` (igual que el del comercial).
- Materiales (`GET/POST /materials`, `POST /materials/upload-url`, `PATCH/DELETE /materials/:id`, `GET /materials/:id/download`): fichero (PDF, imagen u Office, 20 MB), enlace o texto; al editar sin `fileKey` se conserva el fichero. Plantillas (`/templates`, correo o WhatsApp con las variables de `SALES_TEMPLATE_VARIABLES`) y cadencias (`/cadences`; una con cuentas que la usaron se desactiva en vez de borrarse).

**Comisiones**: por cada cobro de la suscripción de un cliente (sin IVA y menos lo devuelto) el % del plan del comercial que la tenía al cobrarse, durante los meses que marque su plan desde el primer pago; un fijo por venta al primer pago; un fijo por cada extra contratado **después** de la venta que apruebe la dirección (los contratados antes del primer pago, o antes de asignarse la cuenta, cuentan solos); conceptos (pedidos por el comercial o añadidos por la dirección) y ajustes. Una devolución posterior resta. Se calculan cada hora.

**Revisión (2026-11-18)**:

- Las comisiones cuentan también los cobros devueltos (`partially_refunded`, `refunded`) con lo que queda: el % y, si se devuelve todo lo cobrado, el fijo por la venta se descuentan. El reparto de cada cobro entre plan y extras se congela al cobrarse (`sales_commission_items.split`). Un comercial desactivado no genera comisiones nuevas; las devoluciones de lo ya cobrado se le siguen descontando.
- `POST /admin/sales-team/claims/:id/approve|reject` se puede volver a decidir: el fijo del extra se aprueba o rechaza si aún no está liquidado; si ya se liquidó, va un ajuste (`Descuento: …` o `Reintegro: …`, con `claimId`). Repetir la misma decisión no hace nada. `POST /admin/sales-team/commissions/items/:id/approve|reject` solo sobre partidas pendientes (409 `item_not_pending`).
- `DELETE /admin/sales-team/reps/:id/concepts/:conceptId` comprueba el comercial (404 `rep_not_found`/`concept_not_found`).
- `PATCH /admin/sales/accounts/:leadId`: un email o teléfono que ya tiene otro contacto → 409 `lead_exists` (el email del propietario de su propia cuenta sí vale). Las altas (`POST /leads`) y la importación al confirmar van de una en una (no se dan de alta dos veces con un doble clic o dos comerciales a la vez).
- `POST /admin/sales/accounts/:leadId/outcome`: `followupDate: null` = sin seguimiento; con fecha, se crea aunque el resultado no tenga uno por defecto. `POST …/activities` con `occurredAt` futuro → 400 `activity_in_future`.
- Un prospecto con un seguimiento pendiente (hasta un año vista) no se libera; las notas con fecha futura no cuentan como actividad.
- `POST /admin/sales/accounts/:leadId/email` va al propietario de la cuenta si ya la tiene (la dirección que enseña la ficha).
- Propuestas: una caducada ya no se acepta sola al contratar el plan; «Hoy» solo enseña las caducadas en las dos últimas semanas y de cuentas que siguen siendo suyas; el recordatorio de caducidad no sale a un lead perdido o descartado, a una cuenta de baja ni a una que ya es de otro comercial. Enviar una propuesta (o la de un extra) cuenta como contacto.
- Ampliar la prueba y dejar probar un extra reservan el tope antes de darlo (dos peticiones a la vez no se lo saltan).
- `GET /admin/sales/accounts/:leadId` de una cuenta pendiente de asignar no trae sus propuestas.
- La lista de leads aplica los filtros en la consulta (antes se cortaba en 500 y filtraba después).
- Descartar o borrar el lead de la cuenta de un cliente que lleva un comercial → 409 `lead_is_sales_client` (hay que quitarle antes el comercial).
- `POST /admin/sales-team/demo/reset` con otro reinicio en marcha → 409 `demo_resetting`; el reinicio deja tipos, locales y trasteros de ejemplo como al crearla; si el de la noche falla, aviso `sales.demo_reset_failed`.
- Avisos que llevaban a pestañas inexistentes ahora llevan a `/admin/sales-team/pending` y a `/admin/sales/results?tab=claims`.

**Funcionalidades (2026-11-18)**:

- Plan (`PUT /admin/sales-team/reps/:id/plan`): `guaranteeMonths` (1-24 o null), `saleTiers` (`[{fromSales ≥ 2, amount}]`, hasta 5) y `targetBonus`; si no se envían, no cambian. `SalesCommissionPlanDto` los devuelve.
- **Garantía**: si el cliente se da de baja (suspendido, cancelado o borrado) antes de esos meses desde su primer pago, el fijo de la venta se rechaza o, si ya se liquidó, se descuenta con un ajuste (`related_item_id`); si se reactiva, vuelve (reintegro).
- **Tramos y bonus**: al cerrar el mes (tarea `sales.hourly`, sobre el mes anterior; o `POST /admin/sales-team/commissions/close-month {month}`, 400 `month_not_closed` con el mes en curso) se crea una partida `tier` = (fijo del tramo − fijo normal) × ventas aprobadas del mes, y una `bonus` si consiguió los clientes y las cuotas de su objetivo. Una de cada por comercial y mes; aviso `sales.month_closed`. `SalesCommissionItemDto.tenantId/tenantName` pueden ser null.
- **Liquidaciones**: `POST /admin/sales/settlements/:id/received {note?}` (el comercial confirma que la ha recibido; 404 si no es suya, 409 `settlement_already_received`); `GET /admin/sales/settlements/:id/receipt` y `GET /admin/sales-team/settlements/:id/receipt` → justificante en PDF. `SalesSettlementDto.receivedAt/receivedNote`.
- **Previsión**: `GET /admin/sales/forecast` → `SalesForecastDto` (su % sobre lo que pagan hoy sus clientes de pago, sin IVA, los próximos 6 meses, respetando los meses de su plan); `GET /admin/sales-team/forecast` → `SalesTeamForecastDto` (por comercial activo y total).
- **Comparativa**: `GET /admin/sales-team/comparison?months=1|3|6|12` → `SalesTeamComparisonDto` (por comercial: prospectos asignados, pruebas, ventas, conversión, días hasta pagar, bajas, cuotas al mes de hoy y comisiones del periodo).

**Panel del cliente**: `GET /settings/sales-rep` → `{rep: TenantSalesRepDto | null}` (nombre, email, teléfono, WhatsApp y enlace de reservas de su comercial, si tiene uno activo).

**Reparto masivo de prospectos (2026-11-24)** (`/admin/sales-team`, rol superadmin; soporte y comerciales 403):

- `POST /distribute/import` (200, `SalesBulkImportSchema`): `{csv, format: csv|xlsx, mode: single|column|even, repId?, repIds?, batch?, commit}`. `single` = todo a `repId`; `column` = la columna «comercial» de cada fila (código del comercial o su email; 400 `rep_column_missing` si el fichero no la tiene); `even` = a partes iguales entre `repIds` (cada fila al que menos prospectos activos lleva, y a igualdad en el orden elegido). Columnas del fichero como en la importación de leads (empresa, persona, email, teléfono, ciudad, trasteros, locales, programa, perfil, origen, nota, campaña); hasta 2.000 filas (400 `too_many_rows`). Comercial inexistente o desactivado → 404 `rep_not_found`.
- `POST /distribute/leads` (200, `SalesDistributeLeadsSchema`): `{leadIds (1-500), mode: single|even, repId?, repIds?, batch?, commit}` para los leads elegidos en la lista.
- Las dos responden `SalesDistributionResultDto`: cada fila con `status` `new` (se da de alta), `assign` (ya estaba sin comercial: se le asigna), `taken` (ya lo lleva un comercial, con su nombre: no se toca), `customer` (ya tiene cuenta: se omite) o `error`, a qué comercial va (`repId`, `repName`), resumen y cuántos a cada comercial (`byRep`). Sin `commit` solo es la vista previa. Al confirmar: asignación con origen `direction` (auditada `admin.sales.account_assigned` y el lote `admin.sales.prospects_distributed`), nota en la ficha, el lote en el lead y **un solo aviso por comercial** (`sales.batch_assigned`, en su panel y por correo) con enlace a `/admin/sales/leads?filter=new_for_you&batch=…`.
- `GET /batches` → `SalesBatchDto[]`: por lote, prospectos, con comercial, comerciales, cuántos en cada fase, sin abrir y fechas del reparto.
- Lista de leads del admin: `GET /admin/leads/list?batch=&noSalesRep=1`. `PlatformLeadDto.salesBatch` y `salesNew` (su comercial aún no lo ha abierto).
- Panel del comercial: `GET /admin/sales/leads?filter=new_for_you&batch=`; `SalesLeadListDto.newForYou` y `batches` (`{name, count}`). Abrir la cuenta (`GET /admin/sales/accounts/:leadId`) le quita la marca.
- **Liberación por inactividad**: también los repartidos por la dirección, contando desde el reparto. Unos días antes (7 o, si el plazo es menor, uno menos que el plazo) se avisa a la dirección con la lista (`sales.leads_release_soon`), una vez por racha de inactividad; solo quedan libres los avisados con esos días cumplidos (`platform_leads.sales_release_warned_at`).

**Cartera del comercial (2026-11-24)** (`/admin/sales`, `@SalesAccess()`; todo limitado a su cartera):

- `GET /leads` → `SalesLeadListDto` por páginas: `?search=&status=&filter=new_for_you|untouched|no_contact|trial_ending|pending&batch=&city=&size=small|medium|large|unknown&temperature=cold|warm|hot|none&sort=priority|value|last_contact|assigned|updated&dir=asc|desc&cursor=&limit=` (`SalesLeadsQuerySchema`; `limit` 1-100, 50 por defecto; un valor no válido → 400 `invalid_query`). Sin corte: el orden se hace sobre todos los que cumplen los filtros. Devuelve además `total`, `nextCursor` (null = no hay más) y `cities` (`{name, count}`). `SalesLeadDto.salesAssignedAt`. «Sin tocar» = prospecto abierto (nuevo, contactado o interesado) sin contacto anotado del comercial. El tamaño sale del número que escribió en trasteros (menos de 50, 50-149, 150 o más).
- `GET /queue` → `SalesQueueDto` («Por hacer»): `items` (`{lead, reason, detail, date, followupId}`) en orden — `followup_overdue`, `followup_today`, `new_untouched` (los 50 de más cuota prevista), `hot_no_contact` (caliente sin hablar en 7 días) y `trial_ending` (prueba de su cliente que acaba en 7 días) —, cada lead una vez; `counts` por motivo y `truncated` (hasta 150).
- `POST /leads/bulk` (200, `SalesBulkLeadActionSchema`): `{leadIds (1-200), action}` con `action.type` `followup` (`title`, `dueDate`, `note?`), `cadence` (`cadenceId`; 404 `cadence_not_found`), `move` (`status` nuevo, contactado o interesado) o `lose` (`reasonCode`, `reason?`). Cada lead por su lado → `SalesBulkLeadResultDto {done, failed: [{leadId, name, message}]}`; los de otra cartera fallan sin nombre. Tocarlos les quita «Nuevo para ti». Auditado `admin.sales.bulk_action`.
- `GET /clients?filter=trial|trial_ending|paying|past_due|onboarding|no_contact|opportunity&search=&temperature=&batch=&sort=name|trial_end|monthly|last_contact|last_login|health&dir=&opportunities=1` (`SalesClientsQuerySchema`). `SalesClientRowDto.batch` y `opportunities` (extras que le podría vender; solo con `opportunities=1` o el filtro `opportunity`).
- Vistas guardadas: `GET/POST /admin/saved-views` y `DELETE /admin/saved-views/:id` admiten al comercial, solo con las páginas `sales_leads` y `sales_clients` (otra → 403 `sales_not_allowed`); cada uno ve y borra solo las suyas. `AdminSavedViewDto.page` devuelve la página real (antes siempre `tenants`); una página que no existe → 400 `invalid_page`.

**No interesados y recuperación (2026-11-24)** (`/admin/sales`, `@SalesAccess()`; todo limitado a su cartera):

- `POST /accounts/:leadId/lose` (`SalesArchiveLeadSchema`): `{reasonCode, reason?, recoverOn?, doNotContact?}`. Deja el prospecto perdido y **archivado** en su cartera: sin `recoverOn`, la fecha que toca por el motivo (Reglas del equipo; por defecto no es el momento 6 meses, le parece caro o elige otro programa 12, no responde 3, el resto 12); con `doNotContact: true`, sin fecha. `recoverOn` tiene que ser a partir de mañana (400 `date_not_future`). Cierra seguimientos, cadencia y secuencia. Ya no admite `recontactOn` (la fecha es `recoverOn`). La dirección, al perder un lead de un comercial (`POST /admin/leads/:id/lose`), también lo archiva con la fecha propuesta.
- `POST /accounts/:leadId/recover` («Recuperar», 200): vuelve a su cartera activa con todo su historial (un prospecto a «Contactado»; un cliente que se dio de baja sigue perdido hasta que vuelva a contratar). 400 `not_archived`. `POST /accounts/:leadId/reopen` de un archivado hace lo mismo. Auditado `admin.sales.lead_recovered`.
- `PATCH /accounts/:leadId/archive` (`UpdateSalesArchiveSchema`): `{recoverOn?, doNotContact?}` (al menos uno). Quitar «No volver a contactar» sin fecha pone la que toca por su motivo. Auditado `admin.sales.archive_updated`.
- `POST /accounts/:leadId/outcome` sobre un archivado: con interés (`interested`, `demo_booked`, `call_later`, `won`) lo recupera; `not_interested` lo aplaza (a `followupDate` si es futura o a la fecha de su motivo) sin crear seguimiento. «No interesado» sobre un prospecto activo lo archiva y su `followupDate` es la de volver a intentarlo.
- `GET /leads` es la cartera activa (sin archivados); `?archived=true&archive=due|scheduled|do_not_contact` lista los archivados. `SalesLeadListDto.archived` = `{total, due, scheduled, doNotContact}`; las cifras por fase (`counts`) son solo de la activa. `PlatformLeadDto.salesArchivedAt`, `salesRecoverOn` (AAAA-MM-DD) y `doNotContact`.
- `GET /queue`: motivo nuevo `recover` (archivados con la fecha ya llegada). `GET /today`: `toRecover` (los mismos, hasta 50). `POST /leads/bulk` con `action.type = 'lose'` admite `recoverOn` y `doNotContact`.
- `GET /me`: `recoverMonths` (meses por motivo, para proponer la fecha).
- **«No volver a contactar»** (`platform_leads.do_not_contact`): seguimientos, correos (también la propuesta y el enlace de registro) y secuencias → 400 `do_not_contact`; la secuencia automática no empieza y la que hubiera se para; cadencia → 400 `do_not_contact` (y `lead_archived` si está archivado); el reparto de la dirección lo omite si no tiene comercial (fila `error`).
- Los archivados con fecha y los de «No volver a contactar» no se liberan por inactividad (decisión 4).
- **Clientes que se dan de baja** (cancelada o anonimizada; una suspensión por impago no): pasan solos a los archivados del mismo comercial con motivo «Cliente que se dio de baja» y fecha a 12 meses (`recoverMonths.churned`), con aviso `sales.client_churned`. Si vuelve a pagar, recuperación ganada y **la mitad de la comisión** (decisión 5): partida `recovery` (la mitad del fijo por venta, una por recuperación) y el % de cada cobro desde la vuelta a la mitad, con sus meses contados desde entonces. `SalesCommissionItemDto.recovery` marca las dos.
- `GET /commissions` → `SalesCommissionsDto.recovery` (`SalesRecoveryStatsDto`: recuperados y ganados del mes y de 12 meses, y cuántos tocan hoy).

Dirección (`/admin/sales-team`, superadmin): `GET /settings` y `PUT /settings` con `recoverMonths` (solo los motivos que cambian, 1-36 meses; 400 si no); `GET /comparison` añade `recovered` y `recoveredWon` por comercial; `GET /recoveries?repId=&take=` → `SalesRecoveryDto[]` (cada archivado: comercial y si sigue activo, clase, motivo, fechas de archivo, de volver a intentarlo, de recuperación y de pago). Avisos: cada mañana (tarea `sales.recovery`, 08:10 hora de España, en el API) a cada comercial con sus archivados a los que ya toca (`sales.recover_due`, una vez por fecha); si el comercial ya no está activo, a la dirección.

**Carteras para la dirección (2026-11-24)** (`/admin/sales-team`, solo superadmin; soporte y comerciales → 403):

- `GET /portfolios?rep=&search=&status=&batch=&temperature=&untouchedDays=&neverContacted=&scope=&kind=&sort=&dir=&cursor=&limit=` → `SalesPortfolioListDto`: `items` (`SalesPortfolioRowDto` = `SalesLeadDto` + `salesRepId`, `salesRepActive`, `lastContactAt`, `neverContacted`, `daysUntouched`, `assignedSource`, `clientMonthly`), `total`, `nextCursor` (`offset_id`), `funnel` (activos por fase con los filtros de comercial, lote, tipo y búsqueda), `archived`, `untouched` (prospectos abiertos sin contacto nunca), `reps` (con su número de cuentas), `noRep` y `batches`. `rep` = uuid o `none` (sin comercial; sin indicar, todos los que tienen). `scope` `active` (por defecto) · `archived` · `all`; `kind` `all` · `prospects` · `clients`; `untouchedDays` 1-730 (días desde el último contacto o, sin contacto, desde que lo lleva). Orden `untouched` (por defecto, más días primero) · `priority` · `value` · `next_step` · `rep` · `stage` · `assigned` · `updated`. Contacto = llamada, WhatsApp, reunión, demo o correo enviado, o el último contacto de la ficha. Filtro mal escrito → 400 `invalid_query`.
- `GET /portfolios/export` (mismos filtros) → `SalesPortfolioRowDto[]` (hasta 5.000, para el CSV).
- `GET /portfolios/:leadId` → `SalesPortfolioDetailDto`: `account` (`SalesAccountDto`), `rep`, `assignedAt`, `assignedSource`, `lastContactAt`, `neverContacted`, `daysUntouched` y `timeline` (`SalesTimelineEntryDto`: `kind` `activity|followup|appointment|quote|cadence|assignment|archive`, `activityType`, `title`, `detail`, `author`, `byDirection`), de lo último a lo primero. 404 `lead_not_found`.
- Acciones (todas devuelven la ficha y quedan auditadas como `admin.sales.direction_*` con `byDirection: true`): `POST /portfolios/:leadId/notes` `{content}` (201; actividad de tipo nuevo `direction` y aviso `sales.direction` al comercial si está activo), `POST …/reassign` `{repId | null}` (origen `manual`; aviso al nuevo y al anterior; 400 `same_rep`, 404 `rep_not_found`), `PATCH …/profile` (`UpdateSalesProfileSchema`; no cambia el último contacto), `POST …/move` `{status}` (`new|contacted|interested`; con cuenta → 400 `stage_automatic`), `POST …/archive` (`SalesArchiveLeadSchema`; 400 `already_archived`) y `POST …/recover` (400 `not_archived`). Lo que el sistema anota por estas acciones pasa a ser de tipo `direction`.
- Actividades de tipo `direction` (`PLATFORM_LEAD_ACTIVITY_LABELS.direction` = «Dirección»): no cuentan como contacto ni como última actividad (`lastActivityAt`, «sin contacto hace tiempo», puntuación) ni como actividad del comercial para la liberación por inactividad.
- `GET/PUT /settings`: `firstContactAlertDays` (0-90; 0 = nunca). Aviso `sales.first_contact_missing` a la dirección (tarea `sales.daily`) con los prospectos abiertos que repartió (orígenes `direction` o `manual` con quien asignó) sin contacto desde el reparto en esos días; una vez por prospecto y reparto (`platform_leads.sales_first_contact_warned_at`).

### Analítica: segunda revisión (2026-11-19)

- **Dinero solo con permiso**: `GET /analytics/monthly-revenue`, `/revenue`, `/revenue-breakdown` y `/aging` exigen además `invoices:read` y `payments:read` (403 `insufficient_permission`). Sin ellos, `occupancy` devuelve `mrrActual`, `mrrPotential` y `economicOccupancy` a `null`; `occupancy-history` las cuotas a `null`; `forecast` `current.mrr`, `avgContractValue` y `projectedMrr` a `null`; `cohorts` `revenuePerContract` a `null`; `churn-risk` `priceMonthly` a `null`; `suggested-actions` sin importes. El Resumen (`/dashboard/overview`) igual: `revenue`, `receivables` y `monthlyRevenue` a `null`.
- **Emisor de las facturas** (plan Administrador): `monthly-revenue`, `revenue`, `revenue-breakdown`, `aging` y `cohorts` aceptan `?ownerId=` — vacío o `self` = tu empresa (por defecto), un id = ese propietario, `all` = todas. Id no válido → 400 `invalid_owner`.
- `?facilityId=` mal escrito → 400 `invalid_facility_id` (antes, 500).
- **Locales por abrir**: no cuentan en las cifras de toda la empresa (ocupación, cuotas con todo alquilado, previsión, comparativa, precios por tipo) hasta que abren; con `?facilityId=` de ese local sí.
- `POST /analytics/pricing-suggestions/apply` cambia el precio del tipo **y el de sus trasteros libres** en todos los locales (con su rastro en el historial de precios); la respuesta lleva `unitsUpdated`. `PricingSuggestionItemDto.availableUnitsAll` dice cuántos son antes de aplicar.
- `POST /analytics/unit-pricing-suggestions/apply` exige un precio mayor que 0.
- `GET /analytics/churn` lleva `started` (altas del mes) en cada mes: una baja de quien entró ese mes cuenta, y la tasa va sobre los activos al empezar más las altas.
- `GET /analytics/exit-reasons?from=&to=` (meses `YYYY-MM`) para el periodo elegido; `months` sigue valiendo.
- `GET /analytics/occupancy-history` sale de quién tuvo cada trastero (un traslado no mueve la historia; una cartera importada cuenta sus trasteros desde el primer inquilino) y añade `yearAgo` (el mismo mes del año pasado).
- `GET /analytics/churn-risk` es **por inquilino** (`contractCount`, trasteros y cuota de todos sus contratos).
- `CompetitionPriceDropDto.comparablePrice`: el precio nuevo del competidor comparable con el tuyo (sin IVA, con seguro, alta y promoción).
- `RevenueForecastDto`: `assumptions.historyMonths` (meses cerrados con actividad) y `current.totalUnits` = trasteros que se pueden alquilar.
- `GET /analytics/pricing-strategy` solo lista los locales que ve el usuario.
- `GET /analytics/benchmark`: mínimo 10 negocios (sin demos ni cuentas exentas) y se reutiliza una hora.

### Analítica: mejoras (2026-11-19)

| Método | Ruta                                                | Permiso                             | Qué devuelve                                                                                                                                                                                                               |
| ------ | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/headline?facilityId=&ownerId=`          | `analytics:read`                    | El mes en curso frente al pasado hasta el mismo día: facturado (null sin permiso de dinero), ocupación de hoy y al cerrar el mes pasado, altas, bajas, contactos y vencido sin cobrar                                      |
| GET    | `/analytics/arrears-breakdown?facilityId=&ownerId=` | + `invoices:read` y `payments:read` | Deuda vencida de los 10 inquilinos que más deben (y cuántos son), por local, y media de días hasta cobrar y de retraso sobre el vencimiento (facturas cobradas en 90 días)                                                 |
| GET    | `/analytics/portfolio-gap?facilityId=`              | + dinero                            | Contratos en vigor que pagan menos que el precio de hoy de su trastero (hasta 200, de mayor a menor diferencia), con la fecha del último cambio de cuota y lo que sumaría al mes                                           |
| GET    | `/analytics/unit-economics?facilityId=`             | + dinero                            | Por tipo de trastero: alquilados, m², cuotas al mes, cuotas por m² alquilado y total, cuota media y precio medio de hoy de esos trasteros                                                                                  |
| GET    | `/analytics/churn-breakdown?from=&to=&facilityId=`  | `analytics:read`                    | Cuotas al mes que entran (altas) y salen (bajas) cada mes (null sin permiso de dinero) y bajas del periodo según lo que llevaban (`lt3`, `3to6`, `6to12`, `12to24`, `gt24` meses)                                          |
| GET    | `/analytics/forecast-scenarios?facilityId=`         | `analytics:read`                    | Tres escenarios (`low`: la mitad de altas y 1,5× bajas; `expected`; `high`) con 12 meses y el mes en que se llenaría (hasta 5 años), y cuándo se llena cada local y tamaño con sus altas menos bajas de los meses cerrados |
| POST   | `/analytics/unit-pricing-suggestions/apply-many`    | `units:manage`                      | `{ items: [{ unitId, price }] }` (1-500): aplica cada precio por separado → `{ applied, failed: [{ unitId, message }] }`                                                                                                   |

- `GET /analytics/leads-funnel` añade `timing`: mediana de horas hasta contactar (`firstResponseHours`, `responded`) y de días hasta ganar (`daysToWin`).
- `GET /analytics/churn-risk` añade el teléfono de cada inquilino (`phone`) y `summary.atStakeMonthly` (cuotas de los de riesgo alto y medio; null sin permiso de dinero).
- Informe nuevo `analytics_month` («Resumen del mes», PDF o Excel, parámetro `month` AAAA-MM): facturado, cobrado, ocupación y cuotas al cerrar, altas, bajas, tasa de bajas y contactos frente al mes anterior. Las facturas son las del propio negocio.

### Mercado: revisión (2026-11-19)

**Competencia**

- `GET /competitors` y `GET /competitors/occupancy` aceptan `?facilityId=` (sus competidores y los que no van ligados a ningún local; mal escrito → 400 `invalid_facility_id`). Quien solo ve algunos locales ve los competidores de esos locales y los sin ligar, y no puede tocar los demás (404).
- Ligar un competidor a un local que no es del negocio o que el usuario no ve → 400 `invalid_facility`.
- `MarketOccupancyDto`: `myOccupancyPct` es la de Analítica (sin locales por abrir ni inquilino de prueba); la media de la competencia solo cuenta inventarios completos comprobados en 180 días. Cada competidor lleva `estimatedOccupancyPct` (con su total conocido; no cuenta en la media) y `stale`; el DTO lleva `facilityId`.
- `CompetitorFacilityDto.lastReviewedAt` es la última comprobación de cualquier trastero suyo o la revisión completa (antes solo «Revisar»). El aviso «sin revisar» usa lo mismo y no avisa de competidores sin trasteros.
- Precios: mayores que 0 en el alta, la edición y la revisión (400).
- `PATCH /competitors/units/:id`: solo cambiar el precio o el estado, o `checked: true` («lo he comprobado hoy»), cuenta como comprobación; corregir la referencia, las notas o las medidas no. `widthM: null` / `depthM: null` quita las medidas.
- Cada cambio queda en el registro de actividad (`competitor.created|updated|deleted|unit_created|unit_updated|unit_deleted|reviewed`).

**Posiciones en Google**

- `GET /seo/search-console` se lee con `analytics:read`.
- Un fallo pasajero de Google deja `status: 'connected'` con `lastError` (los datos siguen a la vista); solo un 401/403/404 de Google lo pasa a `error`.
- `POST /seo/search-console/sync` → 502 `search_console_sync_failed` si la descarga falla.
- Cada descarga repasa desde la última buena (más 6 días) para no dejar huecos. Al conectar se bajan 190 días.
- Se guardan también los totales de cada día de Google (tabla `search_console_days`): los totales de `GET /seo/positions`, el informe y el Resumen de marketing cuadran con el panel de Search Console. `SeoPositionsDto` añade `firstDate` y `previousComplete` (sin el periodo anterior completo no hay avisos ni comparación) y hasta 200 búsquedas.
- `POST /seo/report/send` (`analytics:read`) envía el informe solo a quien lo pide; sin Search Console → 400 `search_console_not_connected`; sin datos del mes → 400 `seo_report_empty`. El envío mensual no va a negocios suspendidos ni se manda vacío.

### Mercado: mejoras (2026-11-19)

**Competencia** (lectura `analytics:read`, cambios `units:manage`)

- `CompetitorUnitDto.comparablePrice` y `comparablePerM2`: lo que paga de media un cliente al mes el primer año, sin IVA, con su seguro obligatorio, su alta y su promoción vigente.
- Competidor: `reviewEveryDays` (cada cuántos días revisarlo; 30 si no tiene) y `promoEndsAt` (`AAAA-MM-DD`; después la promoción no cuenta en el precio comparable ni en la sugerencia de precio). El DTO añade `promotionActive` y `nextReviewOn`. El aviso «toca revisarlo» usa el plazo de cada competidor.
- `GET /competitors/:id/promotions`: histórico de sus promociones (cada cambio cierra la anterior).
- `GET /competitors/price-map?facilityId=` → `MarketPriceMapDto`: por cada tipo de trastero tuyo, tu precio medio frente a la mediana, mínimo y máximo comparables de la competencia en ±25 % de m² (comprobados en 180 días), con la diferencia en %, y los puntos (m², precio) para la gráfica.
- `GET /competitors/:id/trend?months=` (3-24, 12 por defecto): precio comparable medio y ocupación (solo con inventario completo) al cerrar cada mes.
- `POST /competitors/:id/units/bulk {units}` (hasta 200): varios trasteros de una vez.
- `POST /competitors/:id/ai-parse {text}`: la IA lee el texto de su página de tarifas y propone sus trasteros (`matchUnitId` si ya está fichado con esa referencia o esos m²). No guarda nada; gasta una consulta del mes; sin el asistente IA en el plan → 403 `feature_not_in_plan`; respuesta ilegible → 400 `competitor_parse_failed`.
- `GET /competitors/export?facilityId=`: una fila por trastero de la competencia (para el CSV).
- `GET /analytics/competition-alerts` añade `priceRises` (subidas en 30 días donde eres más barato) y `soldOut` (competidores con el inventario completo y comprobado este mes sin libres de un tamaño que tú tienes libre).

**Posiciones en Google** (extra «SEO local»)

- Al conectar se bajan 190 días de búsquedas y 16 meses de totales por día y por dispositivo (tabla `search_console_devices`).
- `SeoPositionsDto` añade `weekly` (clics, apariciones y posición por semana), `brand` (búsquedas con tu marca frente a las demás), `devices`, `yearAgoTotals` (mismas semanas del año pasado, si están descargadas) y `lowCtrPages` (páginas que salen entre los 10 primeros con menos de la mitad de los clics habituales para su posición).
- `PATCH /seo/search-console/settings {brandTerms?, reportRecipientIds?}` (`settings:manage`): palabras de la marca y quién recibe el informe mensual (personas activas del negocio; si no, 400 `invalid_recipient`; vacío = los propietarios).
- `GET /seo/keywords?days=`, `POST /seo/keywords {keyword, targetPosition?}` (204; repetida → 409 `keyword_exists`; hasta 50 → 400 `too_many_keywords`) y `DELETE /seo/keywords/:id`: búsquedas que se siguen con su posición, la anterior y si se ha llegado al objetivo.
- `GET /seo/detail?query=…` o `?page=…&days=`: una búsqueda o una página día a día con sus páginas o sus búsquedas (sin ninguna de las dos → 400 `detail_required`).
- `GET /seo/google-funnel?days=`: clics en Google, visitantes desde Google sin anuncios, contactos y reservas con ese origen, y la página por la que entran.
- Aviso al equipo `seo.clicks_drop` cuando los clics de los últimos 7 días caen un 30 % o más (con al menos 20 la semana anterior), como mucho uno por semana, tras la descarga diaria.

### Revisión de Configuración (2026-11-20)

- **Sesiones**: una sesión cerrada a mano (desde otro dispositivo, «cerrar las demás», cambio o restablecimiento de contraseña) o caducada sin haber rotado da 401 en `/auth/refresh` sin cerrar las demás ni registrar reuso. Con la política de 2FA activa, un propietario o gestor sin 2FA recibe al renovar 403 `two_factor_enrolment_required` con `details.enrolmentToken`.
- **2FA**: con la política activa no se puede quitar (400 `two_factor_required_by_policy`). El emisor en la app de autenticación es siempre «TrasterOS».
- **Equipo**: transferir la propiedad, crear/editar/borrar/asignar roles a medida y asignar locales → solo el propietario (403 `owner_only`), nunca sobre uno mismo (400 `cannot_target_self`); invitar o reenviar como gestor → solo el propietario (403 `insufficient_role`). Reenviar una invitación y reactivar un usuario respetan el límite del plan. Cambiar o restablecer la contraseña anula el cambio de email pendiente.
- **Datos fiscales**: el NIF no se cambia si el negocio ya emitió facturas desde la app (409 `tax_id_locked`); los cambios quedan en el registro de actividad.
- **Registro de actividad** (`GET /audit-logs`): no incluye acciones internas de la plataforma (`admin.*`, notas internas de soporte); lo hecho por soporte sale como «Soporte de TrasterOS» sin datos internos; `auth.refresh` solo filtrando por `auth`; los días del filtro, en la zona del negocio.
- **Protección de datos**: anonimizar da 409 `customer_has_reservations` con reservas vivas y 409 `customer_has_debt` con deuda (salvo `?confirmDebt=1`); cancela los borradores y borra los ficheros de sus documentos. La exportación del inquilino no lleva hashes ni secretos y añade chat, comunicaciones, accesos, incidencias y mandatos (IBAN enmascarado). Plazo de las solicitudes: un mes natural.
- **API keys**: hace falta al menos un permiso (400 `scope_required`). Las claves nuevas tienen la forma `sk_live_<tenantId>.<id>_<secreto>` (las antiguas siguen valiendo).
- **Webhooks**: no se envían a webhooks desactivados; `POST …/deliveries/:id/retry` → 400 `webhook_inactive` si el webhook está revocado.
- `POST /settings/data-export`: como mucho 2 por hora.
- **Facturación**: `GET /billing/aeat-credentials/current` → `{ credential: CredentialDto | null }` (200 también sin certificado). El entorno del certificado sale del modo de la plataforma (`AEAT_MODE`); se ignora el `environment` que llegue. Series: prefijo único (409 `invoice_series_prefix_taken`), caracteres permitidos por la AEAT, una sola serie por defecto por emisor (índice único). Emitir con un número repetido → 409 `invoice_number_taken`. Recargo en porcentaje ≤ 100 (400 `late_fee_percentage_too_high`).
- **Holded**: `POST /settings/holded/backfill` devuelve `{ synced, remaining }` y funciona también en modo `holded`; `HoldedSettingsDto.pendingCount`; en modo `holded` las series de emisión son obligatorias (400 `holded_issuing_series_required`).
- **Cobros**: un cobro salta los métodos de una pasarela apagada (GoCardless desactivado, Redsys sin pago por referencia); elegir uno a mano → 400 `payment_gateway_disabled`. `GoCardlessSettingsDto.webhookUrl`. La domiciliación del portal exige remesas activas y el domicilio completo del acreedor. Los cambios de acreedor SEPA, Redsys y GoCardless quedan en el registro.
- **Escalado de impagos**: el recargo activado exige un valor > 0 y el orden 1.er recordatorio < 2.º ≤ corte ≤ aviso legal.
- **Suscripción**: `TenantSubscriptionDto.billingCycle` (`monthly` | `yearly` | null); `POST /settings/saas-billing/change-plan` conserva la periodicidad si no se indica y devuelve `couponApplied: false` si el cupón no se pudo aplicar; `GET /settings/saas-billing/plans` (públicos + el actual + los de propuestas abiertas); `maxMonths` en las opciones de Redsys de la suscripción.
- **Web**: la web externa no puede ser el propio dominio ni la plataforma; `/aviso-legal`, `/privacidad`, `/cookies` y `/condiciones-contratacion` los sirve la plataforma también con web externa. Dominio propio: 400 `domain_not_allowed` (dominios de la plataforma), 409 `domain_pending_elsewhere` (sin verificar en otra cuenta; se libera a los 7 días). El widget (`GET /public/widget/:slug/facilities`) da el precio como la web, con `taxRate`, y 404 si la web no está publicada.
- **WhatsApp e IA**: `DELETE /settings/whatsapp` (desconecta: borra token, secreto, clave y número; conserva conversaciones). Sin la función se puede leer, desactivar y desconectar. `POST /settings/whatsapp/test`, `/settings/whatsapp/assistant/test` y `/ai/settings/test` prueban lo que llega en el cuerpo (sin guardarlo) o lo guardado. Errores nuevos: `team_hours_required`, `message_hours_required`, `followup_template_required`, `ai_model_required`, `email_domain_provider_unavailable` (503). El token de verificación del webhook solo vuelve con `settings:manage`.
- **Landings**: la reserva admite `utmContent` (id de la landing) y los resultados cuentan por id. `GET /promo-landings/:id/stats` exige además `invoices:read` o `payments:read`.

### Mejoras de Configuración (2026-11-20)

- **Equipo**: `GET /users/limits` (`users:read`) → usuarios activos + invitaciones pendientes frente al límite del plan. `POST /invitations` admite `tenantRoleId` y `facilityIds` (solo el propietario; 403 `insufficient_role`; 400 `role_not_found` / `facility_not_found`); se aplican al aceptar y se conservan al reenviar (400 `invitation_facilities_gone` si ya no queda ninguno). `POST /users/:id/disable-2fa` (solo el propietario, nunca a sí mismo): quita la verificación en dos pasos de un empleado, cierra sus sesiones y le avisa por correo.
- **Registro de actividad**: `GET /audit-logs?sessions=1` incluye inicios, renovaciones y cierres de sesión (por defecto no).
- **Protección de datos**: `GET /rgpd/customers/:id/anonymize-preview` (`rgpd:manage`): qué se borra, qué se conserva y qué lo bloquea. Las solicitudes admiten `receivedAt` (no futura, hasta 30 días atrás; el plazo cuenta desde ella) y al denegar exigen `rejectionReason`, que se comunica por correo.
- **Blog**: `publishAt` programa la publicación (400 `publish_at_in_past`, `blog_post_already_published`; `null` la cancela); un proceso la publica a su hora. `POST /blog-posts/draft` y `POST /promo-landings/draft` (`settings:manage` + `web_premium`, gastan una consulta) devuelven un borrador con IA. Al cambiar la dirección de una entrada o landing, la antigua responde 404 `blog_post_moved` / `promo_moved` con `details.slug` y la web redirige con 308.
- **Preguntas frecuentes**: `questionEn` y `answerEn` (las dos o ninguna: 400 `faq_translation_incomplete`); la web en inglés las usa.
- **Dominio propio**: `GET /settings/tenant/domain/target` (`settings:read`): dominio e IP de la plataforma para los registros DNS. La web responde con y sin `www` (`ResolveDomainDto.canonicalHost`; la otra forma redirige con 308) y la comprobación DNS las mira por separado (`CustomDomainCheckDto.hosts`).
- **Suscripción**: `POST /settings/saas-billing/change-plan` con el mismo plan y otra `billingCycle` cambia entre mensual y anual (Stripe, con prorrateo; sin Stripe 400 `manual_plan_change`).
- **Cobros**: `POST /settings/redsys/test` (`billing:configure`) comprueba el comercio, el terminal y la clave sin cobrar (con lo escrito o lo guardado). `GET /settings/payments/saved-methods-summary` (`settings:read` o `billing:configure`): tarjetas y mandatos guardados por pasarela.
- **Escalado de impagos**: `whatsappReminders`, `whatsappTemplateName` y `whatsappTemplateLanguage` en los ajustes (400 `whatsapp_not_available` sin WhatsApp Business conectado); los recordatorios salen también por WhatsApp.
- **Correo**: `GET /settings/tenant/customer-emails/:kind/preview?locale=es|en` (`settings:read`) → `{subject, html}` con datos de ejemplo; `POST /settings/tenant/customer-emails/:kind/test {locale}` (`settings:manage`, 5 por hora; 429 `too_many_test_emails`). `GET/PUT /settings/tenant/email-reply-to`: adonde llegan las respuestas de los inquilinos, también sin dominio propio.
- **Horarios** (Mensajes, asistente de WhatsApp, chat de la web): cada día admite segundo turno (`open2`/`close2`) y `closedDates` (festivos `AAAA-MM-DD`, hasta 60).
- **Integraciones**: `POST /settings/webhooks/:id/test {event?}` (`integrations:manage`, 10/min) envía una entrega de prueba firmada. Eventos nuevos: `contract.move_out_requested`, `contract.ended`, `booking.created`, `payment.failed`. API de lectura con clave (`Authorization: Bearer sk_live_…`): `GET /v1/integrations/customers[/:id]` (`customers:read`, filtro `email`), `/contracts[/:id]` (`contracts:read`, `status`, `customerId`), `/invoices[/:id]` (`invoices:read`, `status`, `customerId`, `contractId`; sin borradores ni PDF); todas con `updatedSince`, `cursor` y `limit` (≤ 100) → `{data, nextCursor}`. Límite de 120 peticiones por minuto por clave (429 `rate_limited`, `Retry-After`, `X-RateLimit-*`).

### Revisión del soporte del panel del tenant (2026-11-20)

- `GET /support/tickets/page?cursor=&limit=` → `{items, nextCursor}` (más recientes primero; `GET /support/tickets` sigue devolviendo la lista entera).
- `POST /support/tickets`: como mucho 5 por persona en una hora y 20 en un día (429 `too_many_tickets`). Validaciones en español. Publica el evento de tiempo real para el resto del equipo (también el cambio de estado del soporte).
- `SupportTicketDto.closedReason`: `tenant` (lo cerró el negocio), `admin` (el soporte; al reabrirlo vuelve a `null`) o `inactivity` (sin respuesta: recordatorio y cierre automático, y avisos del soporte sin contestar). Migración `20270216110000_support_ticket_closed_reason`.
- En la cara del tenant, el soporte firma `«<nombre de pila> · Soporte de TrasterOS»` (`authorAdminName` y `assignedAdminName`); el admin sigue viendo el nombre completo.
- `POST /support/tickets/:id/rating`: 400 `ticket_not_answered` si el soporte no llegó a responder en el ticket.
- `GET /support/platform-messages/unread-count` (`platform_messages:manage`) → `{count}`; el aviso del menú «Soporte» suma estos y los tickets con respuesta sin leer.
- Durante una impersonación del soporte, abrir o responder un ticket y `POST /support/platform-messages/read` no dejan nada leído para la persona.

### Guías de «Cómo funciona» editables (2026-11-21)

Las guías del código (`HELP_TOPICS`, ahora en `@storageos/shared`) son la base; el super admin las cambia, oculta o añade otras (`platform_help_topics`, migración `20270217110000_help_topics`). Los `id` de las guías no cambian: se enlazan como `/help#<id>`.

| Método | Ruta                                  | Quién                                  | Qué hace                                                                                                                                                                                                                               |
| ------ | ------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/help-topics`                        | cualquier usuario del panel del tenant | `HelpTopicDto[]`: las del código con lo cambiado encima y las nuevas publicadas; sin las ocultas. Unos segundos en memoria (se vacía al guardar).                                                                                      |
| GET    | `/admin/help-topics`                  | super admin (también soporte)          | `AdminHelpTopicDto[]`: todas, con `source` (`code`/`custom`), `edited`, `hidden`, `published`, `position`, `videoUrl`, `imageKey` y la guía `original` del código.                                                                     |
| POST   | `/admin/help-topics`                  | superadmin                             | Guía nueva `{id, content, imageKey?, videoUrl?, position?, published?}` → 201. 409 `help_topic_exists` si el id ya existe (en el código o creado).                                                                                     |
| PUT    | `/admin/help-topics/:id`              | superadmin                             | Cambios parciales `{content?, imageKey?, videoUrl?, position?, published?, hidden?}`. En una guía del código `content: null` vuelve a su texto original; en una creada, 400 `help_topic_content_required`. 404 `help_topic_not_found`. |
| DELETE | `/admin/help-topics/:id`              | superadmin                             | Borra una guía creada; en una del código quita todos los cambios (vuelve a la original y deja de estar oculta) → 204.                                                                                                                  |
| POST   | `/admin/help-topics/image-upload-url` | superadmin                             | `{mimeType, sizeBytes}` (PNG, JPG o WebP, ≤ 2 MB) → URL firmada para subir al bucket público (`platform/help/`). Al guardar `imageKey` se comprueban los bytes reales (`assertObjectMimeType`); la imagen sustituida se borra.         |

- `content`: `group` (uno de los 4 grupos), `title`, `summary`, `steps` (1-12), `links` (hasta 8, **solo rutas internas** `/…`: un enlace externo, `//…` o `javascript:` → 400), `keywords`, `feature`.
- `videoUrl`: solo YouTube o Vimeo (`toEmbedVideoUrl`; otro → 400); el DTO da `videoEmbedUrl` y la web solo carga el reproductor al pulsar «Ver vídeo».
- Las escrituras quedan en `super_admin_audit_logs` (`admin.help_topic.created|updated|reset`, con el `topicId`).
- Web: `/help?q=` guarda la búsqueda en la dirección; `/assistant?q=` deja la pregunta escrita en el asistente (sin enviarla).

### Mejoras del soporte del panel del tenant (2026-11-21)

Migración `20270217120000_support_improvements`: `support_tickets.page_url/user_agent/screen_size/ai_answer`, tabla `support_ticket_watchers` (RLS) y las globales `platform_service_status` y `platform_service_incidents` (sin acceso para `storageos_app`).

| Método | Ruta                            | Quién                                  | Qué hace                                                                                                                                                                                                                                             |
| ------ | ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/support/tickets/page`         | cualquier usuario del panel del tenant | Filtros nuevos: `status` (`open` = abierto o en curso · `waiting` = esperan su respuesta · `closed` = resuelto o cerrado; otro → 400 `invalid_status`), `mine=1` (los que abrió o en los que está en copia) y `search` (asunto y mensajes visibles). |
| PATCH  | `/support/tickets/:id`          | cualquier usuario del panel del tenant | `{priority}` mientras no esté cerrado (400 `ticket_closed`). Subir a alta o urgente avisa al soporte. Auditado `support_ticket.priority_changed`.                                                                                                    |
| POST   | `/support/tickets/:id/reopen`   | cualquier usuario del panel del tenant | Reabre un ticket cerrado durante 7 días tras el cierre (`SUPPORT_TICKET_REOPEN_DAYS`): vuelve a `open` sin `closedReason` y avisa al soporte. 400 `ticket_not_closed` o `ticket_reopen_expired`.                                                     |
| PUT    | `/support/tickets/:id/watchers` | cualquier usuario del panel del tenant | `{userIds}` (hasta 10): sustituye los compañeros en copia; solo usuarios activos del mismo negocio (400 `invalid_watchers`). Los nuevos reciben un correo. Auditado.                                                                                 |
| GET    | `/support/teammates`            | cualquier usuario del panel del tenant | Compañeros activos (sin quien pregunta) que se pueden poner en copia.                                                                                                                                                                                |
| GET    | `/support/response-times`       | cualquier usuario del panel del tenant | `SupportResponseTimesDto`: por prioridad, horas orientativas hasta la primera respuesta = mediana de los últimos 90 días con 5 tickets o más; si no, 2 h urgente, 8 h alta, 24 h normal y 48 h baja (`fromData: false`).                             |
| GET    | `/support/service-status`       | cualquier usuario del panel del tenant | `{status: ok · degraded · incident, message, since, updatedAt}`.                                                                                                                                                                                     |
| GET    | `/admin/service-status`         | super admin (también soporte)          | Lo anterior + `updatedByName` y las 20 últimas incidencias.                                                                                                                                                                                          |
| PUT    | `/admin/service-status`         | superadmin                             | `{status, message}` (mensaje obligatorio salvo con `ok`). Salir de `ok` abre una incidencia, volver la cierra; «desde» solo cambia si cambia el estado. Auditado `admin.service_status.updated`.                                                     |

- `POST /support/tickets` acepta además `category` de la lista fija (`billing`, `access`, `web`, `contracts`, `account`, `bug`, `other`; las antiguas en texto libre siguen guardadas), `pageUrl` (ruta del panel), `screenSize` (`1280x720`), `aiAnswer` (lo que respondió el asistente antes de abrirlo) y `watcherUserIds`. El navegador sale de la cabecera `User-Agent`. Envía «Hemos recibido tu ticket» a quien lo abre (con el plazo orientativo) y «Te han puesto en copia» a los compañeros.
- `SupportTicketDto` gana `pageUrl`, `userAgent`, `screenSize`, `aiAnswer`, `reopenableUntil` y, en el detalle, `watchers`.
- Los avisos por correo del ticket (respuesta, resuelto, cerrado, recordatorio) llegan a quien lo abrió y a los compañeros en copia, una vez por dirección.
- «Preguntar antes al asistente» usa `POST /ai/chat` (gasta una consulta); sin `ai_assistant` o sin `ai:use` no se ofrece.

### Mejoras de «Novedades» (2026-11-21)

Migración `20270217100000_product_updates_improvements`: `product_updates.target_plans/target_roles` (TEXT[], vacío = a todos), `users.product_updates_digest_month` (reserva del resumen mensual por usuario y mes) y las tablas con RLS `product_update_reactions` (una por usuario y novedad) y `tenant_addon_trials` (pruebas gratis de extras que ha tenido cada negocio; se conservan al caducar).

| Método | Ruta                                                | Quién                                  | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | --------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/product-updates/page`                             | cualquier usuario del panel del tenant | Filtros nuevos: `category` (`new`, `improvement`, `fix`; otro → 400 `invalid_category`), `search` (título y texto, sin distinguir mayúsculas, hasta 100 caracteres) y `onlyMyPlan=1` (sin las novedades de funciones que el negocio no tiene).                                                                                                                                                                                                                                                     |
| PUT    | `/product-updates/:id/reaction`                     | cualquier usuario del panel del tenant | «¿Te ha sido útil?»: `{value: 'up' \| 'down' \| null}` (null la quita) → `{value}`. Solo sobre novedades publicadas que le tocan (404 `product_update_not_found`).                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/settings/saas-billing/addons/:addonId/trial`      | `billing:configure`                    | Prueba gratis de un extra activada por el propio negocio desde una novedad: `SELF_ADDON_TRIAL_DAYS` (14) días, como la del super admin (`source: 'trial'`). Una por función y negocio (409 `addon_trial_used`, también si ya probó otro extra que da lo mismo). 400 `addon_without_feature`, `feature_in_plan`, `addon_already_assigned`, `feature_already_enabled` o `addon_not_available`. Auditado `saas_billing.addon_trial_started` y aviso al super admin (`saas_addon.self_trial_started`). |
| POST   | `/admin/product-updates/digest/send`                | superadmin                             | Envía ya el resumen mensual del mes anterior a quien aún no lo tenga → `{month, updates, sent}`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/public/product-updates-digest/unsubscribe/:token` | sin sesión                             | Página de baja del resumen: `{email (enmascarado), unsubscribed}`. Token inválido → 404 `invalid_token`.                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/public/product-updates-digest/unsubscribe/:token` | sin sesión                             | Da de baja del resumen (pone `product_updates_digest: false` en los avisos del usuario). También lo usa el «Cancelar suscripción» del cliente de correo (`List-Unsubscribe-Post`).                                                                                                                                                                                                                                                                                                                 |

- **Novedades dirigidas**: `POST/PUT /admin/product-updates` aceptan `targetPlans` (slugs) y `targetRoles` (`owner`, `manager`, `staff`, `readonly`); vacíos = a todos. El tenant solo ve, cuenta como sin leer y recibe como destacada lo que le toca por su plan actual y su rol. `seenBy` del admin cuenta solo a los destinatarios.
- `ProductUpdateDto` gana `myReaction` y `trialOffer` (`{addonId, addonName, days}` o null: hay un extra activo del catálogo que da la función, no la tiene y nunca ha probado esa función; el más barato si hay varios). `AdminProductUpdateDto` gana `helpfulUp`, `helpfulDown`, `targetPlans` y `targetRoles`.
- **Resumen mensual por correo**: cron `product-updates-digest.monthly` (día 2 a las 9:00, hora de Madrid, en el worker, con `claimDailyCronRun`). A cada usuario activo y verificado de un negocio activo o en prueba, las novedades publicadas el mes anterior que le tocan (si no hay ninguna, nada). Tipo de aviso nuevo `product_updates_digest` en `GET/PATCH /me/email-notices` (activado por defecto para todos los roles; la empresa también lo puede apagar en `/settings/tenant/staff-emails`). Correo de la plataforma con `kind: 'product_updates_digest'` (remitente de «Mensajes del administrador») y enlace de baja propio (`/baja-novedades/<token>`, firmado con una clave distinta de la de las campañas).
- Web: en `/updates`, filtros en la dirección (`?tipo=novedad|mejora|correccion&q=&plan=1`).

### Trasteros cedidos (2026-11-21)

Función `unit_cession` («Trasteros cedidos»): no va en ningún plan ni como extra; la activa el super admin por negocio con los overrides de funciones (`PUT /admin/tenants/:id/features`). El propietario presta un trastero sin contrato, cobro, factura, Veri\*Factu ni comunicación alguna con la persona: el trastero pasa al estado nuevo `ceded` («Cedido») y, para las cifras, cuenta como uno en mantenimiento.

Migraciones `20270218100000_unit_status_ceded` (valor `ceded` del enum `unit_status`) y `20270218110000_unit_cessions` (tabla `unit_cessions` con RLS: persona o inquilino enlazado, desde/hasta, notas, credencial de acceso, estado de antes, quién y cuándo la terminó, avisos enviados; una sola cesión viva por trastero, el historial se conserva).

| Método | Ruta                                | Quién                            | Qué hace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/units/:id/cession`                | `units:read` (alcance por local) | `{cession: UnitCessionDto \| null}`: persona (o inquilino enlazado), teléfono, desde/hasta, `daysLeft` (0 = vence hoy, sigue en plazo; negativo = vencida), `expired` (desde el día siguiente al de fin), notas, precio del trastero sin IVA como referencia y `access` (`{credentialId, status}`, nunca el código).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GET    | `/units/:id/cessions`               | `units:read`                     | Todas las cesiones del trastero (las terminadas con `endedAt`, `endedByName` y `endedUnitStatus`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/units/:id/cession`                | propietario (403 `owner_only`)   | `{holderName?, holderPhone?, customerId?, startsOn?, months? \| endsOn?, notes?}`: a quién (nombre o inquilino) y el plazo, meses (1-60, se suman al inicio ajustando fin de mes) o fecha de fin futura, una de las dos (400). Fechas que no existen (mes 13, 31 de febrero) → 400; el inicio, hoy o antes (400 `invalid_starts_on`), y un inicio pasado cuyo fin ya habría pasado → 400 `cession_already_expired`. Si el fin cae en los próximos 7 días no se avisa de «vence pronto» (sí de «ha vencido»). Sin la función → 403 `feature_not_in_plan`. Solo desde `available`, `maintenance` o `blocked` (409 `unit_not_cedable` / `unit_already_ceded`); con contrato (también borrador) 409 `unit_has_live_contract`; reservado o guardado para alguien 409 `unit_held_by_other`. Con control de accesos crea un PIN solo para ese local y trastero, sin caducidad y sin inquilino (`metadata.source = 'unit_cession'`). No envía nada a nadie. Auditado `unit.ceded`. |
| PATCH  | `/units/:id/cession`                | propietario                      | `{months? \| endsOn?, holderName?, holderPhone?, customerId? (null lo desenlaza), notes?}`. Ampliar suma los meses a la fecha de fin; si ya había vencido, cuentan desde hoy. La fecha nueva no puede ser anterior al inicio ni a hoy (400 `invalid_ends_on`); los avisos vuelven a salir (el de «vence pronto» no, si la fecha nueva cae en los próximos 7 días). Ampliar o cambiar la fecha exige la función (403 `feature_not_in_plan`); editar persona y notas, no. Queda en el historial de estados y en el registro (`unit.cession_extended` / `unit.cession_updated`).                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/units/:id/cession/end`            | propietario                      | `{status?: available \| maintenance \| blocked (por defecto available), reason?}`. Termina la cesión, el trastero queda en ese estado, el acceso se revoca (también en los terminales; si falla, lo revoca después el repaso de credenciales) y, si queda disponible, avisa a la lista de espera. Sin cesión viva 404 `cession_not_found`. Se puede aunque la función ya no esté activada. Auditado `unit.cession_ended`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GET    | `/units/:id/cession/access/code`    | propietario                      | `{code}`: el PIN de la cesión (auditado `access.code_viewed` con IP y navegador). Sin acceso 404 `cession_without_access`. Durante una impersonación del soporte, 403 `not_allowed_while_impersonating` (también al cambiarlo o crearlo).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/units/:id/cession/access`         | propietario                      | Crea el acceso de una cesión que no lo tiene (se cedió sin control de accesos o se perdió) → `UnitCessionDto`. Exige `access_control` (403 `feature_not_in_plan`); con una credencial viva 409 `cession_has_access`. Auditado `unit.cession_access_created`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/units/:id/cession/access/rotate`  | propietario                      | Cambia el PIN (único en el negocio, como el resto) → `{code}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/units/:id/cession/access/suspend` | propietario                      | Deniega el acceso (suspende el PIN) → `UnitCessionDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/units/:id/cession/access/resume`  | propietario                      | Vuelve a permitir el acceso → `UnitCessionDto`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/cessions`                         | `units:read` (alcance por local) | Cesiones vivas del negocio; `?status=active \| expiring \| expired` (vence en 7 días, el día de fin incluido / vencida, desde el día siguiente), `?customerId=`, `?facilityId=`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

- `UnitDto` gana `cession` (`{holderName, endsOn, expired}` de la cesión viva, o null) para pintar la lista y el plano.
- `POST /units/:id/change-status` no saca un trastero de «Cedido» (409 `unit_ceded`: «usa Terminar la cesión») ni lo pone (400 `ceded_via_cession_only`); `DELETE /units/:id` de uno cedido → 409 `unit_ceded`; `POST /contracts` sobre uno cedido → 409 `unit_ceded`; reservas y contactos lo tratan como no reservable (409 `unit_not_reservable`, «Este trastero está cedido: no se puede reservar»). Borrar un local con trasteros cedidos → 409 `facility_has_pending` (bloqueo `ceded_units` en `GET /facilities/:id/delete-preview`). Ceder, reservar, crear un contrato, firmarlo y la reserva online toman el mismo candado por trastero.
- El acceso de una cesión no se cambia desde Accesos (`PATCH/rotate/suspend/resume/revoke` de `/access/credentials/:id` → 409 `credential_managed_by_cession`); sale en Accesos → Temporales con la insignia «Cesión». El repaso de credenciales no toca el de una cesión viva (aunque haya vencido); revoca el de una cesión terminada o que ya no existe.
- **Al vencer no se libera ni se corta el acceso.** Cron `unit-cessions.notices` (cada hora, en el worker): aviso al equipo en el panel 7 días antes del fin (`unit.cession_expiring`; el mismo día, «vence hoy») y desde el día siguiente al del fin (`unit.cession_expired`, «Venció el …»), una vez cada uno por cesión, en la zona horaria del local. Nada a la persona ni al inquilino enlazado.
- «Hoy» (`GET /dashboard/today`) gana `cessionsExpiring` y `cessionsExpired` (`id` = el trastero); no cuentan como urgentes ni en las cifras.
- Anonimizar a un inquilino o a un negocio quita el nombre y el teléfono de sus cesiones; el vaciado de datos de prueba las borra y deja libres los trasteros cedidos. Fusionar inquilinos mueve sus cesiones.

#### Mejoras de las cesiones

Migración `20270220100000_unit_cessions_improvements`: `ends_on` admite nulo (sin fecha de fin), `notice_days` (0, 3, 7, 15 o 30; por defecto 7), `snoozed_until`, `review_every_months` (1, 3, 6 o 12; solo sin fecha de fin, CHECK) con `last_review_notified_at`, `ended_reason`, e índice `access_logs (credential_id, occurred_at DESC)` para la última entrada.

| Método | Ruta                                                                            | Permiso                          | Descripción                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/cessions/page`                                                                | `units:read` (alcance por local) | Página «Cesiones» por cursor (`?status=active \| on_time \| expiring \| due_today \| expired \| ended \| all&search=&facilityId=&cursor=&limit=`) → `PageDto<UnitCessionDto>`. Las vivas se filtran por el estado de cada una (zona del local y su plazo de aviso; `expiring` incluye «vence hoy»); `ended` por fecha de fin desc.; `search` busca por persona, teléfono, inquilino o código del trastero. `GET /cessions` conserva su respuesta (array) y acepta los mismos estados. |
| POST   | `/units/:id/cession/to-contract`                                                | propietario                      | Termina la cesión con motivo «Pasa a contrato», deja el trastero disponible y revoca sus códigos, **sin avisar a la lista de espera** (el trastero queda libre para hacerle el contrato a esta persona; si se avisara, la cola podría guardárselo a otro mientras se rellena el asistente) → `{url: '/contracts/new?unitId=…&customerId=…', cession}`. Auditado `unit.cession_to_contract`.                                                                                           |
| POST   | `/units/:id/cession/snooze`                                                     | propietario                      | `{days: 7 \| 30}`. Pospone el aviso de una cesión vencida (400 `cession_not_expired` si no lo está): sale de «Cesiones vencidas» de «Hoy» y no avisa hasta que pase; entonces avisa una vez más («Sigue vencida…»). No cambia la fecha; ampliar o terminar lo quita. Auditado `unit.cession_snoozed`.                                                                                                                                                                                 |
| PATCH  | `/units/:id/cession/access`                                                     | propietario                      | `{bypassCurfew?, label?}` del código principal (acceso 24 h: salta el toque de queda del local).                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/units/:id/cession/access/codes`                                               | propietario                      | `{label?}`: otro código para la misma cesión (p. ej. su pareja), con el acceso 24 h del principal → `{credentialId, code}`. Como mucho 5 códigos vivos (409 `cession_codes_limit`); exige `access_control`; sin código principal, este pasa a serlo. Auditado `unit.cession_code_created`.                                                                                                                                                                                            |
| GET    | `/units/:id/cession/access/codes/:credentialId/code`                            | propietario                      | El PIN de ese código (404 `cession_code_not_found` si no es de esta cesión).                                                                                                                                                                                                                                                                                                                                                                                                          |
| PATCH  | `/units/:id/cession/access/codes/:credentialId`                                 | propietario                      | `{bypassCurfew?, label?}` de ese código.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/units/:id/cession/access/codes/:credentialId/rotate` · `/suspend` · `/resume` | propietario                      | Igual que los del principal, para ese código.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DELETE | `/units/:id/cession/access/codes/:credentialId`                                 | propietario                      | Quita (revoca) un código que no es el principal (400 `cession_primary_code`).                                                                                                                                                                                                                                                                                                                                                                                                         |

- `POST /units/:id/cession` acepta `openEnded: true` (en vez de `months` o `endsOn`; una de las tres, 400) con `reviewEveryMonths?` (por defecto 3) y `noticeDays?`. `PATCH` acepta `openEnded: true`, `reviewEveryMonths` (solo sin fecha: 400 `review_needs_open_ended`) y `noticeDays`; `months` sobre una sin fecha cuenta desde hoy. El primer recordatorio de una sin fecha es a los N meses de crearla (o de quitarle la fecha), no del inicio.
- `UnitCessionDto` gana `state` (`on_time \| expiring \| due_today \| expired \| ended`), `noticeDays`, `reviewEveryMonths`, `snoozedUntil`, `endedReason` y `codes` (los códigos vivos, el principal el primero); `endsOn` y `daysLeft` son null sin fecha de fin; `access` y cada código llevan `label`, `primary`, `bypassCurfew` y `lastUsedAt` (última entrada permitida del registro de accesos; en `access`, la última con cualquiera de sus códigos). `UnitCessionSummaryDto.endsOn` puede ser null.
- Todos los códigos llevan `metadata.cessionId`: se revocan juntos al terminar la cesión y el repaso de huérfanos los encuentra; el RGPD de un inquilino anonimiza su nombre y etiqueta.
- **Avisos al propietario** (`sendNotices`, cron `unit-cessions.notices`): «vence pronto» según `noticeDays` de cada cesión, «ha vencido» (respetando el aviso pospuesto) y, sin fecha de fin, «Sigue cedido el trastero X a Y desde hace N meses» (`unit.cession_review`) cada `reviewEveryMonths`. Cada uno a la campana, al móvil del equipo (`unit.cession_expiring`, `unit.cession_expired` y `unit.cession_review` en `STAFF_PUSH_TYPES`) y por correo a los propietarios activos y verificados (tipo de aviso `unit_cession`, activado por defecto solo para propietarios, se apaga en Ajustes → Correo o en el perfil). Nada a la persona ni al inquilino enlazado.
- «Hoy»: `cessionsExpiring` usa el plazo de aviso de cada cesión; `cessionsExpired` no incluye las pospuestas; las sin fecha de fin no salen.
- `GET /inventory/issues` detecta un trastero `ceded` sin cesión viva (→ `available`, se corrige con «Corregir») y una cesión viva cuyo trastero no está `ceded` (`fixable: false`, `link` a la ficha; `POST /inventory/issues/:unitId/fix` → 409 `inventory_issue_needs_action`). `InventoryIssueDto` gana `fixable` y `link`.

### Seguimientos, Trials, En riesgo y Oportunidades: arreglos (2026-11-25)

- `GET /admin/leads/followups` (sin `mine`) y `leadFollowupsDue` de `GET /admin/today` ya no incluyen los seguimientos asignados a comerciales (están en Carteras). Con `?mine=1`, los del que llama. Tope de 300 (`PLATFORM_LEAD_FOLLOWUPS_LIST_LIMIT`); `GET /admin/followups` tiene tope de 500 (`ADMIN_FOLLOWUPS_LIST_LIMIT`), los más antiguos primero.
- `POST /admin/tenants/:id/followups` sin `assignedToId`: lo lleva quien lo crea (si no es comercial); con `assignedToId: null`, sin asignar. Igual en los seguimientos que crean el playbook, las propuestas de extras y de cuota y el lote de Salud.
- `POST /admin/tenants/:id/risk-snooze` admite `kind` (`trial_expiring | past_due | inactive | low_health | trial_expired`): solo oculta esa sección (sin `kind`, todas, como antes). `GET /admin/tenants/at-risk` añade `trialExpired` (activos con la suscripción caducada: pruebas que terminaron sin pagar), `snoozed[] {id, name, kind, until, reason}` y, en cada fila, `expired` (prueba ya vencida sin cerrar, que sigue en `trialExpiring`) y `playbookAt` (último playbook en 14 días). `inactive` solo cuenta clientes de pago (suscripción activa con cuota) con más de 14 días de alta; `snoozedCount` sin borrados. `GET /admin/today` no aplica este «ignorar».
- `GET /admin/tenants/trials`: `daysLeft` en días naturales de España (0 = vence hoy) y `expired` nuevo. `POST /admin/tenants/extend-trials` devuelve `skipped[] {tenantId, name, reason}`.
- `POST /admin/tenants/:id/addon-offers`: 409 `addon_offer_recent` si ese extra se le propuso en los últimos 14 días; 409 `addon_trial_used` si pide prueba y ya tuvo una de ese extra; 400 `tenant_not_live` si está suspendido o de baja; 400 `no_recipients` (sin efectos) si no tiene propietarios verificados que no se hayan dado de baja de las ofertas. El correo lleva el enlace de baja y `List-Unsubscribe`. `POST /admin/tenants/:id/addon-trials/:addonId` → 409 `addon_trial_used` si ya tuvo una prueba de ese extra.
- `GET /admin/opportunities`: solo tenants activos o en prueba; reglas revisadas (cámaras con dispositivos o credenciales de acceso; SEPA y automatizaciones con inquilinos con contrato vivo; capacidad al 80 % contando la que dan sus extras; regla de usuarios con activos + invitaciones pendientes; trasteros sin locales borrados).
- `POST /feature-interest` durante una impersonación responde `{recorded: false}` sin apuntar nada (también en solo lectura).

### Seguimientos, Trials, En riesgo y Oportunidades: mejoras (2026-11-25)

Panel super admin. Todo bajo `AdminGuard`; lo marcado _superadmin_ devuelve 403 al rol soporte.

**Seguimientos (tenants y leads juntos)**

- `GET /admin/followups/inbox?tab=today|overdue|upcoming|done&search=&assignedTo=<id|none>&mine=1&kind=tenant|lead` → `{items: AdminFollowupItemDto[], counts: {today, overdue, upcoming, done}, truncated}`. Hechos = los cerrados en 30 días. No salen los seguimientos de prospectos asignados a comerciales. Máx. 200 por pestaña (`truncated`). 400 `invalid_query`.
- `GET /admin/followups/overdue-count` → `{count}`: vencidos antes de hoy (hora de Madrid) asignados a mí o sin asignar (aviso del menú).
- `POST /admin/followups {kind, subjectId, title, dueDate, note?, assignedToId?}` → el seguimiento. Sin `assignedToId`, lo lleva quien lo crea (en un lead, el responsable del lead si lo tiene). 400 `date_in_past`, `invalid_assignee` (en los de tenants no puede ser un comercial); 404 `tenant_not_found`/`lead_not_found`.
- `PATCH /admin/followups/items/:kind/:id {title?, note?, dueDate?, assignedToId?, status?, outcome?}`: editar, marcar hecho (guarda `outcome` y quién lo cerró; con `outcome`, nota en la conversación del tenant o actividad del lead) o reabrir (`status: 'pending'` borra lo de cerrado).
- `POST /admin/followups/bulk {items: [{kind, id}], action: 'postpone'|'assign'|'done', days?, assignedToId?, outcome?}` → `{updated, skipped}` (los hechos o inexistentes y los responsables que no valen para ese tipo se saltan).
- `PATCH /admin/followups/:id` (tenants) y `PATCH /admin/leads/followups/:id` guardan también quién lo marca hecho.

**Trials**

- `GET /admin/trials?search=&filter=all|this_week|expired|unused|real_use&salesRepId=&page=` → `{items, total, page, pageSize (25), counts, summary}`. Cada fila es la de `GET /admin/tenants/trials` más `progress {done, total, missing[]}` (local, trasteros, inquilinos, primer contrato, datos fiscales, forma de cobro), `conversion {level: high|medium|low, reason}`, `invoices`, comercial y lead de origen. `summary`: `inProgress`, `endedThisMonth`, `convertedThisMonth`, `conversionMonthPct`, `avgDaysToPay` (embudo de 3 meses), `extendedThisMonth`.
- `GET /admin/trials/expired` → pruebas que terminaron sin pagar (tenant activo con la suscripción caducada) con fecha de fin, días, uso, comercial y lead. Reabrir = `POST /admin/tenants/:id/extend-trial`.

**En riesgo**

- `GET /admin/tenants/at-risk` (el único endpoint de la página; «Hoy» y el resumen semanal llaman al servicio sin el «ignorar») añade a cada fila `monthly` (cuota al mes sin IVA; en pruebas, la del plan), `ownerId/ownerName/ownerSource` (`followup`: responsable de su seguimiento abierto más próximo; `sales`: su comercial) y `lastContactAt/lastContactType` (última conversación anotada); dos secciones nuevas, `scheduledEnd` (baja o anonimización programadas) y `cancelAtPeriodEnd`, que respetan el «ignorar» por sección (`AtRiskKind` gana `scheduled_end` y `cancel_at_period_end`) y llevan `playbookAt`; y `monthlyAtStake`. Cada sección va de más cuota a menos.
- `POST /admin/tenants/:id/retention-playbook/preview {reason?, message?}` → `{subject, body, recipients}`.
- `POST /admin/tenants/:id/retention-playbook` admite `reason` (`past_due`, `trial_expiring`, `trial_expired`, `inactive`, `low_health`, `scheduled_end`, `cancel_at_period_end`) y `message` (al principio del correo). El motivo queda en el registro.

**Oportunidades**

- `GET /admin/opportunities/overview` → `{addons, byTenant, dismissals, totals {candidates, tenants, potentialMonthly}, pricesIncludeVat}`. Por extra: `potentialMonthly` (precio × candidatos) y `acceptance {sent, won, trialing, ratePct}` de los últimos 90 días; por candidato: `offer {status: sent|trialing|won|no_response, sentAt, trialUntil}` (sin respuesta tras 14 días) y su comercial. Los descartados no salen.
- `POST /admin/opportunities/dismissals {tenantId, addonId, days: 30|90|180|null, reason}` (_superadmin_; `null` = siempre; repetir sustituye) y `DELETE /admin/opportunities/dismissals/:id` (_superadmin_).
- `POST /admin/opportunities/bulk-propose/preview {addonId, tenantIds, trialDays?}` → `{willSend [{tenantId, tenantName, recipients}], skipped [{tenantId, tenantName, reason}], emails}` (se saltan los suspendidos o de baja, los que ya lo tienen, los descartados, los propuestos en 14 días —`ADDON_OFFER_COOLDOWN_DAYS`—, con prueba gratis los que ya la tuvieron, y los que no tienen propietarios verificados sin la baja de las ofertas). En el envío, `propose` vuelve a comprobarlo todo y lo que falle va a `skipped` con su mensaje.
- `POST /admin/opportunities/bulk-propose {addonId, tenantIds (≤100), message?, trialDays?, followupDays}` (_superadmin_) → `{sent, emails, skipped}`.
- `POST /admin/opportunities/hand-off {tenantId, addonId, note?}` (_superadmin_) → `{salesRepName, followupId}`: seguimiento para su comercial en el prospecto del tenant (si viene de uno), nota en la conversación del tenant y aviso en su campana. 400 `no_sales_rep`.
- Cada propuesta (suelta o en lote) queda en `platform_addon_offers`.
