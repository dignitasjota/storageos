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
| DELETE | `/facilities/:id`             | SI   | owner, manager        | Soft delete (sets `deleted_at`)                                                                  |
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
| POST   | `/contracts/:id/request-end`                  | SI   | owner, manager        | Pasa a ending con `{endDate?}` (último día; sin ella, hoy + preaviso). El día siguiente se finaliza solo si el tenant tiene `autoEndContracts` (cron `contracts.auto-end`)                                                                                                  |
| POST   | `/contracts/:id/end`                          | SI   | owner, manager        | Pasa a ended + libera unit. Si el contrato es de **prepago** (semestral/anual), genera una rectificativa R1 en **borrador** que abona los meses completos no consumidos de la factura pagada que cubre la fecha de baja (el staff la emite y reembolsa a mano; idempotente) |
| POST   | `/contracts/:id/cancel`                       | SI   | owner, manager        | Cancela + libera unit                                                                                                                                                                                                                                                       |
| POST   | `/contracts/:id/change-price`                 | SI   | owner, manager        | Cambia precio con motivo (registrado en eventos)                                                                                                                                                                                                                            |
| POST   | `/contracts/:id/notes`                        | SI   | owner, manager, staff | Anyade nota a la timeline                                                                                                                                                                                                                                                   |
| POST   | `/contracts/:id/generate-pdf`                 | SI   | owner, manager        | Genera PDF con Puppeteer                                                                                                                                                                                                                                                    |
| GET    | `/contracts/:id/inspection-photos?kind=`      | SI   | `contracts:read`      | Fotos de inspección (check-in/check-out) con URL firmada GET; filtra por `kind`                                                                                                                                                                                             |
| POST   | `/contracts/:id/inspection-photos/upload-url` | SI   | `contracts:write`     | Signed URL PUT a MinIO (bucket privado `uploads`); body `{kind, mimeType, fileName}`                                                                                                                                                                                        |
| POST   | `/contracts/:id/inspection-photos`            | SI   | `contracts:write`     | Registra la foto `{kind, key, note?}`; 400 `invalid_photo_key` si la key no es del contrato+kind                                                                                                                                                                            |
| DELETE | `/contracts/:id/inspection-photos/:photoId`   | SI   | `contracts:write`     | Borra una foto de inspección                                                                                                                                                                                                                                                |

### Endpoints — Reservations

| Metodo | Ruta                                    | Auth | Roles                 | Descripcion                                        |
| ------ | --------------------------------------- | ---- | --------------------- | -------------------------------------------------- |
| GET    | `/reservations`                         | SI   | cualquiera            | Filtros `?unitId=&customerId=&status=&facilityId=` |
| GET    | `/reservations/:id`                     | SI   | cualquiera            | Detalle                                            |
| POST   | `/reservations`                         | SI   | owner, manager, staff | Crea reserva (409 si overlap)                      |
| POST   | `/reservations/:id/confirm`             | SI   | owner, manager, staff | Pasa a confirmed + unit.status = reserved          |
| POST   | `/reservations/:id/cancel`              | SI   | owner, manager, staff | Cancela + libera unit si era ultima activa         |
| POST   | `/reservations/:id/convert-to-contract` | SI   | owner, manager        | Crea contrato draft y marca reserva converted      |
| POST   | `/reservations/expire-due`              | SI   | owner, manager        | Marca como expired las pending/confirmed caducadas |

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

| Metodo | Ruta                           | Auth | Roles                 | Descripcion                                                                                                                                                                                                       |
| ------ | ------------------------------ | ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/invoices`                    | SI   | cualquiera            | Filtros `?status=&customerId=&contractId=&overdue=true`                                                                                                                                                           |
| GET    | `/invoices/:id`                | SI   | cualquiera            | Detalle con items, hash, qrCodeUrl                                                                                                                                                                                |
| POST   | `/invoices`                    | SI   | owner, manager, staff | Crea borrador con items                                                                                                                                                                                           |
| PATCH  | `/invoices/:id`                | SI   | owner, manager, staff | Edita (lineas solo en draft)                                                                                                                                                                                      |
| POST   | `/invoices/:id/issue`          | SI   | owner, manager        | Asigna numero + hash + QR; envia AEAT (stub/real)                                                                                                                                                                 |
| POST   | `/invoices/:id/cancel`         | SI   | owner, manager        | Borrador → `cancelled`. Emitida sin cobros → `rectified` + rectificativa de abono por el total, emitida y compensada (400 `invoice_has_payments` / `invoice_not_cancellable`; 409 con cobro en curso o en remesa) |
| POST   | `/invoices/:id/refund`         | SI   | owner, manager        | Reembolso parcial o total                                                                                                                                                                                         |
| POST   | `/invoices/:id/mark-paid`      | SI   | owner, manager, staff | Pago manual (efectivo, transferencia, tarjeta)                                                                                                                                                                    |
| POST   | `/invoices/:id/generate-pdf`   | SI   | owner, manager        | Genera PDF con QR Verifactu y persiste signed_pdf_url                                                                                                                                                             |
| POST   | `/invoices/jobs/run-recurring` | SI   | owner, manager        | Dispara manualmente el job de facturas recurrentes                                                                                                                                                                |

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

| Metodo | Ruta               | Auth | Roles          | Descripcion                                                 |
| ------ | ------------------ | ---- | -------------- | ----------------------------------------------------------- |
| GET    | `/reports/catalog` | SI   | cualquiera     | Lista generators con `paramsSchema` para pintar formularios |
| GET    | `/reports`         | SI   | cualquiera     | Lista report_runs del tenant (paginacion in-memory 50)      |
| GET    | `/reports/:id`     | SI   | cualquiera     | Status + downloadUrl si done                                |
| POST   | `/reports/run`     | SI   | owner, manager | Encola job; devuelve run en `pending`                       |

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

| Metodo | Ruta                                 | Auth | Roles          | Descripcion                                               |
| ------ | ------------------------------------ | ---- | -------------- | --------------------------------------------------------- |
| GET    | `/access/credentials`                | SI   | cualquiera     | Filtros `?status=&type=&customerId=&unitId=`              |
| GET    | `/access/credentials/:id`            | SI   | cualquiera     | Detalle sin secret                                        |
| POST   | `/access/credentials`                | SI   | owner, manager | Crea. Devuelve `revealedSecret` en payload (una sola vez) |
| POST   | `/access/credentials/:id/rotate`     | SI   | owner, manager | Genera secret nuevo. Devuelve `revealedSecret`            |
| POST   | `/access/credentials/:id/transition` | SI   | owner, manager | State machine                                             |
| DELETE | `/access/credentials/:id`            | SI   | owner, manager | Revoke (no hard delete)                                   |

### Endpoints — Access devices

| Metodo | Ruta                             | Auth | Roles               | Descripcion                                                                            |
| ------ | -------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/access/devices`                | SI   | cualquiera          | Lista con facility + unitos vinculados                                                 |
| POST   | `/access/devices`                | SI   | owner, manager      | Crea. Devuelve `apiKey` plaintext (una sola vez)                                       |
| POST   | `/access/devices/:id/rotate-key` | SI   | owner, manager      | Rota apiKey. Devuelve plaintext nuevo                                                  |
| PATCH  | `/access/devices/:id`            | SI   | owner, manager      | Edita nombre/unidades vinculadas                                                       |
| DELETE | `/access/devices/:id`            | SI   | owner, manager      | Soft delete                                                                            |
| POST   | `/access/devices/:id/ping`       | SI   | owner/manager/staff | Comprueba conectividad (open de prueba)                                                |
| POST   | `/access/devices/:id/open`       | SI   | owner, manager      | Apertura remota (server→controlador). Registra `access_logs`. `{dispatched, message?}` |

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

| Metodo | Ruta                     | Auth       | Descripcion                                                                                               |
| ------ | ------------------------ | ---------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/admin/auth/login`      | Public     | Body `{email, password}`. Si 2FA off → access + cookie refresh. Si 2FA on → `{requires2fa, pendingToken}` |
| POST   | `/admin/auth/refresh`    | cookie     | Cookie `super_admin_refresh`. Rota cookie. Paranoid reuse                                                 |
| POST   | `/admin/auth/logout`     | AdminGuard | Revoca sesion actual + borra cookie                                                                       |
| POST   | `/admin/auth/logout-all` | AdminGuard | Revoca todas las sesiones                                                                                 |
| GET    | `/admin/auth/me`         | AdminGuard | Datos del super admin                                                                                     |

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
| GET    | `/admin/metrics`                            | AdminGuard              | KPIs globales (MRR, tenants activos, churn)                                                                                                                                                                                                                                                                                                          |

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
- **Retry policy**: cola BullMQ `verifactu` con `attempts: 3, backoff: exponential 60s` (≈1m, 5m, 25m). Reintenta solo si `result.status='error'` (tecnico). `rejected` no reintenta (decision firme AEAT). `removeOnFail: false` para visibilidad manual.
- **Reenvio manual**: `POST /billing/invoices/:id/resend-aeat` vuelve a `pending` y reencola (400 `already_accepted` si la AEAT ya la aceptó; si hubo un envío previo, antes de reenviar se consulta a la AEAT). Emitir en envío real (`AEAT_MODE` ≠ stub) exige NIF válido del emisor (400 `tenant_tax_id_required`) y, en facturas completas, NIF/NIE válido del cliente español (400 `customer_tax_id_required`).

### Endpoints — Credenciales AEAT del tenant

| Metodo | Ruta                           | Auth | Roles          | Descripcion                                                                          |
| ------ | ------------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------ |
| POST   | `/billing/aeat-credentials`    | SI   | owner          | `multipart/form-data` con `file` (.p12/.pfx) + `password` + `environment` (max 50KB) |
| GET    | `/billing/aeat-credentials/me` | SI   | owner, manager | Metadata: CN, NIF, issuer, validFrom, validTo, environment, uploadedAt               |
| DELETE | `/billing/aeat-credentials/me` | SI   | owner          | Body `{reason}`. Revoca (`revokedAt`, `revokedReason`)                               |

### Endpoints — Reenvio factura

| Metodo | Ruta                                | Auth | Roles          | Descripcion                                                     |
| ------ | ----------------------------------- | ---- | -------------- | --------------------------------------------------------------- |
| POST   | `/billing/invoices/:id/resend-aeat` | SI   | owner, manager | Vuelve a `pending` + reencola job (202); 400 `already_accepted` |

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

| Metodo | Ruta                     | Auth       | Descripcion                                                                          |
| ------ | ------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| GET    | `/admin/security-events` | AdminGuard | Filtros `?eventType=&emailAttempted=&fromDate=&toDate=&cursor=&limit=`. Solo lectura |

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

### Landings de promoción (`/promo-landings`, extra Web Premium)

Páginas propias por promoción en la web del tenant, con el estilo de su plantilla.

- `GET /promo-landings`, `GET /promo-landings/:id` (`settings:read`); `POST`, `PATCH /:id`, `DELETE /:id`, `POST /:id/duplicate` (copia apagada con dirección `<slug>-copia`) (`settings:manage`). Sin la feature `web_premium` → 403. Errores: 409 `promo_slug_taken`, 400 `invalid_reference` (cupón, local o tamaño de otro tenant), 400 `invalid_dates`.
- Foto principal: `POST /promo-landings/:id/image/upload-url {mimeType, sizeBytes}` (JPG/PNG/WebP ≤5 MB, bucket público) y `PUT /promo-landings/:id/image {heroImageKey|null}` (la clave debe empezar por `<tenant>/promo/<id>/`).
- `PromoLandingDto`: nombre, `slug`, `isActive`, `startsAt`/`endsAt`, `live` (activa y dentro de fechas), titular, subtítulo, oferta, texto, ventajas, condiciones, texto del botón, foto, cupón (`couponId`/`couponCode`), locales y tamaños (vacío = todos), secciones (cuenta atrás, opiniones, preguntas, contacto), SEO e `indexable` (por defecto no).
- **Pública**: `GET /public/landing/:slug/promo/:promoSlug` → `{ site: PublicLandingDto, promo: PublicPromoLandingDto }` (el cupón solo si sigue activo, con `summary` y `minMonths`). Apagada, fuera de fechas, inexistente o sin `web_premium` → 404 `promo_not_available`; la web redirige a la portada.
- **Resultados (PR 3)**: `GET /promo-landings/:id/stats?days=` (`settings:read`; 0 = desde siempre, 30 por defecto) → `PromoLandingStatsDto`: visitas y visitantes, reservas online desde la landing (contacto con `utm_campaign` = `promo-<nombre>`), firmadas, pagadas (1ª factura cobrada), ingresos (lo cobrado en esa 1ª factura, sin fianza ni retención), usos del cupón y desglose por origen. Una reserva de un contacto que ya existía toma el origen de la reserva.
- **Origen de la visita** (2026-10-21): la web del tenant guarda en el navegador de dónde vino el visitante (`utm_*`, `gclid`/`fbclid`…, o la web de la que viene; `detectTrafficSource` en shared) y lo envía como `utmSource`/`utmMedium`/`utmCampaign` en `POST /public/move-in/book/:slug`, `…/lead` y `POST /public/landing/:slug/contact` (este último lo acepta desde ahora y lo guarda en el contacto). Las visitas de las landings usan ese origen si el enlace no trae utm.
- **Analítica propia de la web** (2026-10-22): `POST /public/landing/:slug/events {visitorId, kind, path, source?, medium?, campaign?}` (público, 120/min, 204; `kind` = `page_view` | `call_click` | `whatsapp_click` | `email_click` | `directions_click`; los robots se ignoran por el navegador que declaran; una página vista cuenta una vez por visitante y página cada 30 min). `GET /marketing/web-analytics?days=7|30|90` (`marketing:read`) → `WebAnalyticsDto`: totales y periodo anterior (visitantes, contactos, reservas), visitantes por día en la zona del tenant, embudo por origen (visitantes, páginas, llamadas, WhatsApp, email, cómo llegar, contactos web, reservas, firmadas, pagadas, ingresos del primer pago, gasto de los canales con ese `utmSourceMatch` y coste por reserva), 15 páginas más vistas con sus clics de contacto y visitantes por dispositivo.
- **Google Analytics 4** (2026-10-22, `@RequireFeature('web_premium')`): `GET /marketing/ga4` (`marketing:read`) → `Ga4SettingsDto` (cuenta de servicio disponible y su email, propiedad, estado, último error y última descarga); `PUT /marketing/ga4 {propertyId}` (`marketing:manage`; acepta `123456789` o `properties/123456789`) comprueba el acceso y descarga 120 días → 400 `ga4_no_access` (queda guardada con el motivo) o 503 `ga4_not_configured`; `DELETE` borra la conexión y los datos; `POST /marketing/ga4/sync` descarga ya los últimos 6 días; `GET /marketing/ga4/report?days=7|30|90` (`marketing:read`) → `Ga4ReportDto` hasta ayer: sesiones, con interacción, páginas vistas, eventos clave (y el periodo anterior), sesiones por día, por origen/medio, páginas y dispositivos. Cron `ga4.daily` (06:45, worker). Simulado con `NODE_ENV=test`/`GSC_MODE=stub` (la propiedad `403403403` no da acceso).
- **Rendimiento de los anuncios** (2026-10-22): la sincronización de Google Ads y Meta Ads (manual o cron) guarda además impresiones, clics y conversiones de la plataforma por canal y día (`ad_metrics_daily`; Meta cuenta como conversión `lead`, `purchase`, `contact`, `schedule`, `submit_application` y `complete_registration`). `GET /marketing/channels/ads-performance?from=&to=` (`marketing:read`, por defecto los últimos 30 días; 400 `invalid_date`) → `AdPerformanceDto`: por canal de anuncios, impresiones, clics, gasto (de las métricas; si aún no hay, de los gastos vinculados), conversiones de la plataforma, contactos y reservas/firmadas con su `utmSourceMatch`, CTR, coste por clic, por contacto y por reserva, y el último día con datos; más los totales.
- **Instagram y Facebook orgánico** (2026-10-22, `@RequireFeature('web_premium')`): `GET /marketing/social` (`marketing:read`) → `SocialSettingsDto` (página, Instagram vinculado, estado, último error y descarga). `PUT /marketing/social {accessToken, pageId?}` (`marketing:manage`): comprueba el token con Meta, guarda el de la página cifrado y descarga 30 días; 400 `social_token_invalid` (token caducado o sin permisos, con el motivo), `social_no_pages`, `social_choose_page` (varias páginas: `details.pages[]` con `id`, `name`, `instagramUsername`) y `social_page_not_found`. `POST /marketing/social/sync` descarga ya los 3 últimos días; `DELETE /marketing/social` borra el token y lo descargado. `GET /marketing/social/report?days=7|30|90` (`marketing:read`) → `SocialReportDto`: por red, seguidores (último dato) y su cambio, totales y periodo anterior (alcance, visualizaciones, visitas al perfil, clics a la web, interacciones, nuevos seguidores) y alcance por día; las 6 mejores publicaciones (`socialPostScore`: alcance o interacción) y, por red, visitantes, contactos y reservas de la web con ese origen. El resumen de marketing (`MarketingSummaryDto`) suma `current/previous.socialFollowers` y `socialReach` (null sin conectar) y `connections.social`.
- **Puesta en marcha** (2026-10-22): `GET /dashboard/onboarding` (`settings:read`) → `OnboardingDto`: `steps[]` con `key`, `label`, `hint`, `done`, `group` (`required` | `recommended`), `href` y `secondary` opcional (atajo de importación); `progress` y `completed` cuentan solo los imprescindibles; `requiredDone/Total` y `recommendedDone/Total`. El paso `series` solo aparece si el tenant no tiene serie activa; `verifactu` no aparece en modo Holded.
- **Resumen de marketing** (2026-10-22): `GET /marketing/summary?month=YYYY-MM` (`marketing:read`; por defecto el mes pasado en la zona del tenant; 400 `invalid_month`) → `MarketingSummaryDto`: cifras del mes y del anterior (visitantes, clics de contacto, contactos de la web y de cualquier origen, reservas online, firmadas, pagadas, cobrado en el primer pago, gasto en la categoría Marketing, clics de anuncios, sesiones de GA4 y clics de Search Console —null sin conectar—), hasta 8 orígenes con su embudo y gasto, lo conectado y hasta 5 consejos (`marketingSummaryTips`: `warning` primero, luego `good` e `info`, cada uno con la página donde actuar). `PUT /marketing/summary/report {enabled}` (`marketing:manage`, 204) activa o apaga el correo mensual; `POST /marketing/summary/report/send` (`marketing:manage`) envía ya el del mes pasado a los propietarios → `{recipients, month}`.
- **Seguimiento (PR 2)**: `POST /public/landing/:slug/promo/:promoSlug/visit {visitorId, source?, medium?, campaign?}` (público, 30/min, 204; lo manda la página al abrirse; un visitante cuenta una vez cada 30 min; apagada no cuenta). Un canal de marketing con `promoLandingId` (`POST/PATCH /marketing/channels`, 400 `promo_landing_not_found` si no es del tenant) lleva su enlace corto / QR a la landing en vez de a la reserva, y `MarketingChannelDto.landingUrl` da la dirección con `utm_source` = su `utmSourceMatch`, `utm_medium` según el tipo (`cpc`, `paid_social`, `offline`, `referral`, `other`) y `utm_campaign` = `promo-<nombre>`. La landing pasa esas variables a la reserva (sin ellas: `web` / `landing` / `promo-<nombre>`).

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
- **Lista de supresión**: `GET /customers/:id/email-status` (`customers:read`, bloqueos del email del inquilino) + `POST /customers/:id/email-status/clear` (`customers:write`, desbloquea). Panel admin: `GET /admin/email-settings/suppressions?search=&cursor=` + `DELETE /admin/email-settings/suppressions/:id` (superadmin).
- `GET /communications/channels` (`communications:read`): `{ email, whatsapp }` — si WhatsApp puede enviar de verdad. Crear un envío por WhatsApp que no puede salir (manual, automatización, valoración) → 400 `whatsapp_not_available`; los ya creados quedan `skipped` al despachar.
- `GET /communications/page` (`communications:read`): historial paginado por cursor → `{items, nextCursor}`; `search` (destinatario, asunto, inquilino), `from`/`to`, `status`, `channel`, `customerId`, `leadId`, `source`, `limit` (máx. 100).
- `GET/PATCH /me/email-notices` (cualquier usuario): qué avisos por correo al equipo recibe → `{notices: {new_lead, new_booking, move_out_requested, portal_incident}, disabledByTenant}`.
- `GET /admin/email-log` (super admin, también soporte): historial de los correos de la plataforma → `{items, nextCursor}`; `search` (destinatario, asunto, tenant), `tenantId`, `kind`, `status`.
- `GET /sepa/remittances/:id/prenotices` (`payments:read`): constancia del preaviso de cada adeudo → `[{invoiceNumber, customerName, amount, status (null|sent|disabled|no_email|failed), at, recipient, subject, text, deliveryStatus, itemStatus (pending|collected|failed|returned|cancelled), failureReason}]`. El listado de remesas añade `prenoticesSent`/`prenoticesMissing`.
- `GET /public/landing/:slug` añade `latestBlogPosts` (las 4 últimas entradas publicadas, con Web Premium) y admite la plantilla `onepagemovil`.
- `GET/PATCH /settings/tenant/billing` incluye `firstPaymentNextMonthFromDay` (2-28, `null` = desactivado; 20 por defecto): si el contrato mensual empieza a partir de ese día (y no el día 1), la primera factura cubre también el mes siguiente completo y la recurrente empieza el mes después (`billingStartsOn`). El resumen del primer pago (`POST /public/move-in/book/:slug/quote` acepta `startDate`; el portal usa el día de hoy y la firma la fecha del contrato) trae `firstMonth` (`periodStart`, `periodEnd`, `days`, `daysInMonth`, `includesNextMonth`, `firstMonthRent`, `nextMonthRent`, sin IVA) con el mismo importe que la factura.
- `PATCH /settings/tenant/billing` acepta `transferIban` (IBAN para transferencias, validado; `''` lo quita). Sale en el correo de «Nueva factura» de quien no tiene cobro automático ni domiciliación.

### Subidas de precio / ECRI (`/rent-increases`)

- `POST /rent-increases/preview` (`contracts:manage`): contratos afectados (active/ending + antigüedad mínima + local/tipo) con precio nuevo (% o € fijo) + delta de MRR, sin persistir.
- `GET /rent-increases` + `GET /rent-increases/:id` (`contracts:read`): el detalle incluye los items (old/new price + estado).
- `POST /rent-increases` (`contracts:manage`): programa la tanda (congela items + envía el preaviso por email) con `effectiveDate`.
- `POST /rent-increases/:id/apply` (`contracts:manage`): aplica ya (sube `priceMonthly` + evento `price_changed`). Idempotente. También lo hace el cron `rent-increases.apply` en la fecha efectiva.
- `POST /rent-increases/:id/cancel` (`contracts:manage`): cancela una tanda programada.

### Seguro / protección recurrente (`/insurance-plans`, `/contracts/:id/insurance`)

- `GET /insurance-plans` (`insurance:read`; `?onlyActive=true`) + `POST`/`PATCH /:id`/`DELETE /:id` (`insurance:manage`): catálogo de planes (prima mensual, cobertura, IVA, activo).
- `PUT /contracts/:id/insurance` (`contracts:write`): asigna (`{planId}`) o quita (`{planId:null}`) el seguro; congela la prima en `contracts.insurance_price`. También se asigna en el alta con `CreateContractSchema.insurancePlanId`.
- La prima se factura como una línea recurrente más en la factura mensual del alquiler (`billing-jobs`). `ContractDto` expone `insurancePlanId`/`insurancePlanName`/`insurancePrice`.

### Move-out self-service (portal del inquilino)

- `GET /portal/me/contracts` (`@Public` + sesión de portal): contratos active/ending del inquilino (`PortalContractDto`).
- `POST /portal/me/contracts/:id/request-move-out {endDate}` (`@Public` + sesión + throttle): solicita la baja. Valida propiedad (404 si no es suyo) + preaviso (`endDate ≥ hoy + cancellationNoticeDays`, 400 `notice_period_not_met`) → contrato a `ending`. Emite `contract_move_out_requested` → notificación al staff + encuesta de salida (NPS). El staff finaliza el contrato en la fecha (no auto-finaliza).

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

- `POST /ai/chat` (`ai:use`): body `{ conversationId?, content }`. Crea la conversación si no se pasa id; el asistente puede invocar herramientas read-only (ocupación, vencidas, métricas, búsqueda/resumen de cliente) ejecutadas con el contexto del tenant **y del usuario**: solo se ofrecen las que su rol permite (métricas e ingresos por mes `analytics:read`, ocupación y disponibilidad `units:read`, vencidas `invoices:read`, clientes `customers:read`, contratos que vencen `contracts:read`, leads `leads:read`, tareas `tasks:read`, incidencias `incidents:read`, gastos `expenses:read`) y los datos se filtran por su `facilityScope`. Devuelve `{ conversationId, message }` (con `toolsUsed`). 503 `ai_not_configured` si el provider anthropic no tiene API key.
- `POST /ai/chat/stream` (`ai:use`, 2026-09-28): mismo body y misma lógica que `/ai/chat`, pero responde en **Server-Sent Events** (`text/event-stream`, cabecera `X-Accel-Buffering: no` para que Nginx no retenga el stream). Eventos `data: {…}`: `text` (`delta` de la respuesta), `tool` (`name` de la herramienta que se consulta; el texto previo de esa vuelta no forma parte de la respuesta final), `done` (`conversationId` + `message` guardado, igual que `/ai/chat`) y `error` (`code`, `message`). Los errores previos a abrir el stream (403 sin feature, 503 `ai_not_configured`, 400 de validación) responden como siempre. La web lo usa y cae a `/ai/chat` si el streaming no está disponible.
- **Acciones con confirmación** (2026-09-28): el asistente puede PROPONER (nunca ejecutar) tres acciones mediante herramientas `propose_*`, solo si el rol tiene el permiso: crear tarea (`tasks:write`), recordatorio de pago de una factura pendiente (`communications:send`, respeta `facilityScope`) y mensaje al inquilino por el chat del portal (`customers:write`). La propuesta se valida y se guarda en `ai_pending_actions` (`proposed`); `AiMessageDto.actions` la muestra bajo el mensaje.
  - `POST /ai/actions/:id/confirm` (`ai:use`): ejecuta con los permisos ACTUALES del usuario y los servicios normales (misma validación y auditoría que desde el panel) → `confirmed` + `resultLink`, o `failed` + `resultError`. Reserva atómica: confirmar dos veces ejecuta una sola vez. Auditado `ai.action_confirmed`/`ai.action_failed`.
  - `POST /ai/actions/:id/discard` (`ai:use`): `discarded`; ya no se puede confirmar.
  - Solo el usuario que la propuso puede decidir (otro → 404).
- `GET /ai/conversations` (`ai:use`) + `GET /ai/conversations/:id` + `DELETE /ai/conversations/:id`: scoped por usuario.
- Provider por `AI_PROVIDER=stub|anthropic` (+ `ANTHROPIC_API_KEY`, `AI_MODEL`). El stub permite dev/test sin coste.

### Fiscalidad — libro de IVA + 303 + 347 (`/fiscal/...`)

- `GET /fiscal/vat-book?from=&to=` (`invoices:manage`): libro registro de facturas expedidas (filas por factura + desglose por tipo de IVA + totales).
- `GET /fiscal/model-303?year=&quarter=` (`invoices:manage`): IVA devengado por tipo del trimestre (parte de IVA repercutido; el soportado lo aporta la asesoría).
- `GET /fiscal/model-347?year=` (`invoices:manage`): clientes con operaciones anuales > 3.005,06 € con NIF y desglose trimestral.
- Solo lectura, derivado de las facturas emitidas (estados ≠ draft/cancelled, por `issue_date`).

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

| Endpoint / área                                                                                                           | Cambio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /customers/:id/portal-link/revoke-sessions`                                                                         | **Nuevo** (`customers:write`, 204, auditado `portal.sessions_revoked`): cierra todas las sesiones vivas del portal del inquilino.                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /customers/:id/portal-link/send-email`                                                                              | **Nuevo** (`customers:write`, 200 `{sentTo}`, auditado `portal.access_email_sent`): envía al inquilino un correo de bienvenida con su enlace de acceso al portal (un solo uso, 7 días) y el enlace al login para pedir otro; remitente del tenant. 400 `customer_without_email`. El alta del panel lo llama si la casilla «Enviar acceso por email» está marcada (por defecto).                                                                                                                                           |
| `GET/PATCH /settings/tenant/customer-emails`                                                                              | **Nuevo** (`settings:read` / `settings:manage`, auditado): correos automáticos al inquilino — `invoice_issued`, `payment_received`, `payment_failed`, `contract_signed`, `contract_ending_soon`, `move_out_confirmed`; todos `true` por defecto. El PATCH acepta solo esas claves (400 si hay otras).                                                                                                                                                                                                                     |
| `GET/PATCH /settings/tenant/staff-emails`                                                                                 | **Nuevo** (`settings:read` / `settings:manage`, auditado): avisos por email a propietarios y gestores — `new_lead` (contacto desde web/widget), `new_booking` (reserva online), `move_out_requested`, `portal_incident`; todos `true` por defecto.                                                                                                                                                                                                                                                                        |
| `GET /admin/email-settings/platform-domain`                                                                               | Super admin: lista `[{domain, brevo, resend}]`, uno por cada dominio de los remitentes de la plataforma, con `authenticated`/`pending`/`missing`/`no_key`/`error` en cada proveedor.                                                                                                                                                                                                                                                                                                                                      |
| `GET/PUT /admin/email-settings/senders`                                                                                   | Leer: super admin; cambiar: rol superadmin, auditado `admin.email_senders.updated`. Remitentes de la plataforma — `default` y opcionalmente `account`, `subscription`, `billing`, `admin_messages`, `staff_notices`, cada uno `{name?, email?, replyTo?}` (`''` = vacío; el nombre admite `{tipo}`) — y `tipoLabels` por correo concreto (`null` = texto por defecto, `''` = sin texto). La respuesta incluye lo guardado, `env`, lo `effective` por tipo y `kinds` (texto de `{tipo}` y remitente final de cada correo). |
| `GET /automations/runs?ruleId=`                                                                                           | **Nuevo** (`automations:read`, feature `automations`): últimas 50 ejecuciones (de todas las reglas o de una) con estado `succeeded`/`skipped`/`failed` y motivo. `POST`/`PATCH /automations` validan ahora la plantilla (del tenant y del canal de la acción) y rechazan `send_sms`.                                                                                                                                                                                                                                      |
| `POST /webhooks/email-events/brevo?token=` · `POST /webhooks/email-events/resend`                                         | **Nuevo** (públicos, `VERSION_NEUTRAL`): avisos de entrega. Brevo con token en la URL (`EMAIL_WEBHOOK_TOKEN`, 401 si no coincide); Resend con firma Svix (`RESEND_WEBHOOK_SECRET`, cuerpo crudo). Sin la variable → 404. Entregado → `delivered`; rebote/bloqueo/email inválido → `bounced`; error → `failed` (+ notificación al tenant). Rechazos de correos que no están en `communications` → `super_admin_notifications` (1 por motivo y día). Devuelven `{matched}`.                                                 |
| `POST /portal/me/password`                                                                                                | Ahora **200** con una `PortalSessionDto` nueva (antes 204): cambiar la contraseña con la sesión iniciada cierra todas las demás sesiones del portal y este dispositivo sigue dentro con el token devuelto.                                                                                                                                                                                                                                                                                                                |
| `/portal/me/*`                                                                                                            | 401 **`portal_session_revoked`** si la sesión fue revocada (revocación por el staff, cambio, reset o desactivación de la contraseña del portal).                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /auth/password/forgot`, `POST /auth/resend-verification`, `POST /portal/login/request`, `POST /portal/login/forgot` | Responden **204 inmediatamente** y generan el token / envían el email en segundo plano (misma latencia exista o no la cuenta).                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /admin/auth/login`                                                                                                  | Cuenta desactivada + contraseña incorrecta → **401** (antes 403 `account_disabled` sin comprobar la contraseña).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /auth/2fa/challenge`, `POST /admin/auth/2fa/challenge`                                                              | Tope por usuario (429 `too_many_2fa_attempts`) + anti-replay TOTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST/PATCH /settings/webhooks`                                                                                           | 400 **`webhook_url_not_allowed`** (`details.reason`) si la URL apunta a infraestructura interna (IP privada, nombre sin dominio, `.local`, credenciales en la URL). En el envío, un destino no permitido marca el delivery `failed` sin reintentos. No se siguen redirecciones.                                                                                                                                                                                                                                           |
| `POST /webhooks/email-inbound`                                                                                            | Nuevos campos opcionales `dmarc`, `dkim`, `spf`, `authenticationResults`. Sin DMARC `pass`, el mensaje se guarda con `senderVerified: false` (`CustomerMessageDto.senderVerified`).                                                                                                                                                                                                                                                                                                                                       |
| Endpoints «register» de ficheros subidos                                                                                  | 400 **`file_too_large`** (> 20 MB); el objeto rechazado (tamaño o contenido) se borra.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /access/credentials`, `POST /access/credentials/:id/rotate`                                                         | El PIN manual pasa a **6–8 dígitos** (antes 4–8). Los PIN existentes siguen verificando.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /portal/me/doors/:deviceId/open`                                                                                    | Ya **no** se bloquea por el lockout del teclado (anti-fuerza-bruta) del dispositivo.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Notificaciones                                                                                                            | Nuevo tipo `access.device_locked` al saltar el bloqueo del teclado.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Rate limiting                                                                                                             | La IP es la real del cliente (`TRUST_PROXY_HOPS`, default 1): los límites vuelven a ser por cliente.                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

- `GET /admin/crons` (tareas programadas: última ejecución, siguiente prevista, atrasada), `GET /admin/billing-health` (facturas con problemas en Veri\*Factu, Holded para revisar, certificados), `GET /admin/usage?days=` (correo, IA y almacenamiento por tenant) y `POST /admin/usage/measure-storage` (superadmin).
- `GET /admin/tenants/:id/config` (configuración del tenant, solo lectura y sin secretos).
- Novedades: `GET /product-updates`, `GET /product-updates/unread-count`, `POST /product-updates/seen` (cualquier usuario del tenant); `GET/POST /admin/product-updates`, `PUT/DELETE /admin/product-updates/:id` (escribir: superadmin).
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

### Viviendas (#642–#645)

- `unit_types.propertyKind` (`storage`|`housing`); marcar un tipo como vivienda exige la feature `housing` (403 `feature_not_in_plan`).
- `PATCH /settings/tenant/contract-template` acepta `housingClauses` (plantilla de vivienda aparte) y `autoEndContracts` (cerrar solas las bajas al día siguiente de su fecha; activado por defecto).
- Depósito de la fianza: `PUT /contracts/:id/deposit-registry`, `POST /contracts/:id/deposit-registry/receipt-upload-url` (`contracts:write`) y `GET /contracts/:id/deposit-registry/receipt` (`contracts:read`); 400 `not_housing`. `TodayDto.depositsToRegister`.
- Actualización anual: `GET/PUT /contract-anniversaries/settings`, `GET /contract-anniversaries/due` (`contracts:read`) y `POST /contract-anniversaries/apply {contractIds, action: apply|skip}` (`contracts:manage`).

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
- `POST /portal/me/contracts/:id/move-out-date {endDate}`: cambia la fecha de una baja en curso respetando el preaviso (400 `contract_not_ending` / `notice_period_not_met`); aviso al equipo `contract.move_out_date_changed`.
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
