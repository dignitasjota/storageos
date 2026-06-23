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

| Metodo | Ruta                        | Auth | Throttle  | Descripcion                                             |
| ------ | --------------------------- | ---- | --------- | ------------------------------------------------------- |
| POST   | `/auth/register`            | NO   | 3/hora/IP | Crea tenant + owner; envia email; no emite tokens       |
| POST   | `/auth/login`               | NO   | 5/min/IP  | Login `(tenantSlug, email, password)`                   |
| POST   | `/auth/refresh`             | NO   | 30/min/IP | Rota refresh y emite nuevo access                       |
| POST   | `/auth/verify-email`        | NO   | 30/min/IP | Activa la cuenta con el token del email; emite sesion   |
| POST   | `/auth/resend-verification` | NO   | 3/hora/IP | Reenvia el email de verificacion; 204 generico          |
| POST   | `/auth/password/forgot`     | NO   | 3/hora/IP | Pide reset; envia email; 204 generico                   |
| POST   | `/auth/password/reset`      | NO   | 5/min/IP  | Cambia password con el token; revoca todas las sesiones |
| POST   | `/auth/logout`              | SI   | 60/min/IP | Revoca la sesion actual                                 |
| POST   | `/auth/logout-all`          | SI   | 60/min/IP | Revoca todas las sesiones del user                      |
| GET    | `/auth/me`                  | SI   | 60/min/IP | Devuelve `{ user, tenant, subscription }`               |

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
history/me, Holded test/backfill/sync) → `invoices:manage` (owner+manager); lecturas
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
     "otpauthUri": "otpauth://totp/StorageOS:jane%40acme.com?...",
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

| `code`                   | Cuando                                              |
| ------------------------ | --------------------------------------------------- |
| `already_enabled`        | `setup`/`verify` con 2FA ya activo.                 |
| `setup_required`         | `verify` sin haber llamado a `setup` antes.         |
| `not_enabled`            | `disable`/`regenerate` con 2FA apagado.             |
| `wrong_current_password` | `disable`/`regenerate` con password incorrecta.     |
| `invalid_code`           | Codigo TOTP o recovery invalido en cualquier flujo. |

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

| Metodo | Ruta                                  | Auth | Roles                 | Descripcion                                            |
| ------ | ------------------------------------- | ---- | --------------------- | ------------------------------------------------------ |
| GET    | `/customers`                          | SI   | cualquiera            | Lista con `?search=` por nombre/email/doc              |
| GET    | `/customers/:id`                      | SI   | cualquiera            | Detalle + counts (activeContracts/pendingReservations) |
| POST   | `/customers`                          | SI   | owner, manager, staff | Crea customer (individual o business)                  |
| PATCH  | `/customers/:id`                      | SI   | owner, manager, staff | Actualiza                                              |
| DELETE | `/customers/:id`                      | SI   | owner, manager        | Soft delete                                            |
| POST   | `/customers/:id/kyc`                  | SI   | owner, manager        | Marca/desmarca KYC verificado                          |
| GET    | `/customers/:id/documents`            | SI   | cualquiera            | Lista documentos                                       |
| POST   | `/customers/:id/documents/upload-url` | SI   | owner, manager, staff | Signed URL PUT para MinIO                              |
| POST   | `/customers/:id/documents`            | SI   | owner, manager, staff | Registra el documento tras subirlo                     |
| DELETE | `/documents/:id`                      | SI   | owner, manager        | Borra documento                                        |

### Endpoints — Contracts

| Metodo | Ruta                          | Auth | Roles                 | Descripcion                                        |
| ------ | ----------------------------- | ---- | --------------------- | -------------------------------------------------- |
| GET    | `/contracts`                  | SI   | cualquiera            | Filtros `?status=&customerId=&facilityId=&unitId=` |
| GET    | `/contracts/:id`              | SI   | cualquiera            | Detalle con `effectivePrice` calculado             |
| GET    | `/contracts/:id/events`       | SI   | cualquiera            | Timeline inmutable de eventos                      |
| POST   | `/contracts`                  | SI   | owner, manager, staff | Crea borrador                                      |
| PATCH  | `/contracts/:id`              | SI   | owner, manager, staff | Edita campos meta (no precio)                      |
| POST   | `/contracts/:id/sign`         | SI   | owner, manager        | Pasa a active + ocupa unit                         |
| POST   | `/contracts/:id/request-end`  | SI   | owner, manager        | Pasa a ending                                      |
| POST   | `/contracts/:id/end`          | SI   | owner, manager        | Pasa a ended + libera unit                         |
| POST   | `/contracts/:id/cancel`       | SI   | owner, manager        | Cancela + libera unit                              |
| POST   | `/contracts/:id/change-price` | SI   | owner, manager        | Cambia precio con motivo (registrado en eventos)   |
| POST   | `/contracts/:id/notes`        | SI   | owner, manager, staff | Anyade nota a la timeline                          |
| POST   | `/contracts/:id/generate-pdf` | SI   | owner, manager        | Genera PDF con Puppeteer                           |

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

| Metodo | Ruta                           | Auth | Roles                 | Descripcion                                             |
| ------ | ------------------------------ | ---- | --------------------- | ------------------------------------------------------- |
| GET    | `/invoices`                    | SI   | cualquiera            | Filtros `?status=&customerId=&contractId=&overdue=true` |
| GET    | `/invoices/:id`                | SI   | cualquiera            | Detalle con items, hash, qrCodeUrl                      |
| POST   | `/invoices`                    | SI   | owner, manager, staff | Crea borrador con items                                 |
| PATCH  | `/invoices/:id`                | SI   | owner, manager, staff | Edita (lineas solo en draft)                            |
| POST   | `/invoices/:id/issue`          | SI   | owner, manager        | Asigna numero + hash + QR; envia AEAT (stub/real)       |
| POST   | `/invoices/:id/cancel`         | SI   | owner, manager        | Cancela                                                 |
| POST   | `/invoices/:id/refund`         | SI   | owner, manager        | Reembolso parcial o total                               |
| POST   | `/invoices/:id/mark-paid`      | SI   | owner, manager, staff | Pago manual (efectivo, transferencia, tarjeta)          |
| POST   | `/invoices/:id/generate-pdf`   | SI   | owner, manager        | Genera PDF con QR Verifactu y persiste signed_pdf_url   |
| POST   | `/invoices/jobs/run-recurring` | SI   | owner, manager        | Dispara manualmente el job de facturas recurrentes      |

### Endpoints — Payments

| Metodo | Ruta                             | Auth | Roles                 | Descripcion                                                              |
| ------ | -------------------------------- | ---- | --------------------- | ------------------------------------------------------------------------ |
| GET    | `/payments`                      | SI   | cualquiera            | Lista con filtros `?invoiceId=&customerId=`                              |
| POST   | `/payments/invoices/:id/charge`  | SI   | owner, manager        | Charge automatico (usa payment_method default si no hay paymentMethodId) |
| GET    | `/customers/:id/payment-methods` | SI   | cualquiera            | Lista metodos guardados del customer                                     |
| POST   | `/payment-methods/setup-intent`  | SI   | owner, manager, staff | Crea Stripe SetupIntent + Customer si falta                              |
| POST   | `/payment-methods`               | SI   | owner, manager, staff | Registra metodo tras setupIntent (cifra token)                           |
| DELETE | `/payment-methods/:id`           | SI   | owner, manager        | Soft delete                                                              |
| POST   | `/webhooks/stripe`               | NO   | publico (HMAC)        | Eventos Stripe (raw body + Stripe-Signature)                             |

### Endpoints — Dunning + RGPD

| Metodo | Ruta                            | Auth | Roles          | Descripcion                                   |
| ------ | ------------------------------- | ---- | -------------- | --------------------------------------------- |
| GET    | `/dunning`                      | SI   | cualquiera     | Lista acciones programadas/ejecutadas         |
| GET    | `/rgpd/requests`                | SI   | owner, manager | Lista solicitudes de derechos RGPD            |
| POST   | `/rgpd/requests`                | SI   | owner, manager | Crea solicitud (SLA 30 dias auto)             |
| GET    | `/rgpd/customers/:id/export`    | SI   | owner, manager | Exporta JSON con todos los datos del customer |
| POST   | `/rgpd/customers/:id/anonymize` | SI   | owner, manager | Anonimiza preservando invoices                |

### Endpoints — Portal del cliente

| Metodo | Ruta                                      | Auth | Throttle  | Descripcion                                                                                                                                                    |
| ------ | ----------------------------------------- | ---- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/portal/login/request`                   | NO   | 5/min/IP  | Envia magic link al email (204 silencioso)                                                                                                                     |
| POST   | `/portal/login/consume`                   | NO   | 5/min/IP  | Intercambia token por JWT corto (single-use)                                                                                                                   |
| GET    | `/portal/me/invoices`                     | NO   | 60/min/IP | Bearer JWT portal; lista facturas del cliente                                                                                                                  |
| GET    | `/portal/me/payment-methods`              | NO   | 60/min/IP | Bearer JWT portal; lista metodos de pago del cliente                                                                                                           |
| POST   | `/portal/me/payment-methods/setup-intent` | NO   | 5/min/IP  | Bearer JWT portal; crea SetupIntent Stripe (self-service IBAN/tarjeta)                                                                                         |
| POST   | `/portal/me/payment-methods`              | NO   | 5/min/IP  | Bearer JWT portal; registra el PM confirmado (pasa a predeterminado; tipo derivado del gateway)                                                                |
| POST   | `/portal/me/invoices/:id/charge`          | NO   | 5/min/IP  | Bearer JWT portal; cobra el pendiente con el PM predeterminado. 404 si la invoice no es del customer del token; 400 `no_payment_method` si no hay PM           |
| GET    | `/portal/me/access`                       | NO   | 60/min/IP | Bearer JWT portal; credenciales pin/qr activas del inquilino con el valor descifrado (para mostrar/presentar)                                                  |
| POST   | `/portal/me/access/:id/regenerate`        | NO   | 5/min/IP  | Bearer JWT portal; regenera el secreto de SU credencial (404 si no es suya). Devuelve el nuevo valor                                                           |
| POST   | `/portal/me/access/extra`                 | NO   | 5/min/IP  | Bearer JWT portal; crea un acceso adicional (PIN, body `{label}`) hasta `tenants.extra_access_limit`. 409 `extra_access_limit_reached` al exceder              |
| GET    | `/portal/me/access/night-pass`            | NO   | 60/min/IP | Bearer JWT portal; disponibilidad + precio del pase nocturno (`{enabled, price}`)                                                                              |
| POST   | `/portal/me/access/night-pass`            | NO   | 5/min/IP  | Bearer JWT portal; compra un pase nocturno (PIN de un solo uso que salta el toque de queda, caduca a la mañana siguiente) + factura. 409 `night_pass_disabled` |

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

| Metodo | Ruta                        | Auth | Roles                 | Descripcion                                             |
| ------ | --------------------------- | ---- | --------------------- | ------------------------------------------------------- |
| GET    | `/communications`           | SI   | cualquiera            | Filtros `?status=&channel=&customerId=&leadId=&source=` |
| GET    | `/communications/:id`       | SI   | cualquiera            | Detalle                                                 |
| POST   | `/communications`           | SI   | owner, manager, staff | Envio manual (resuelve template + outbox + queue)       |
| POST   | `/communications/:id/retry` | SI   | owner, manager        | Reintenta una en estado `failed`/`bounced`              |

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
| POST   | `/leads/:id/convert`    | SI   | owner, manager, staff | Crea customer + (opcional) reservation, marca won    |
| DELETE | `/leads/:id`            | SI   | owner, manager        | Soft delete                                          |

### Endpoints — Widget publico

| Metodo | Ruta                                  | Auth | Throttle  | Descripcion                                                                                       |
| ------ | ------------------------------------- | ---- | --------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/public/widget/:slug/facilities`     | NO   | 30/min/IP | Lista locales activos del tenant con unit types                                                   |
| POST   | `/public/widget/:slug/leads`          | NO   | 5/min/IP  | Crea lead `source=widget` con honeypot anti-bot                                                   |
| GET    | `/public/landing/:slug`               | NO   | 60/min/IP | Landing SEO: empresa + locales (dirección/contacto) + disponibilidad/precio. Alimenta `/s/[slug]` |
| GET    | `/public/landing/:slug/:facilitySlug` | NO   | 60/min/IP | Landing SEO de un local concreto (por `publicSlug`). Alimenta `/s/[slug]/[facility]`              |
| GET    | `/public/landing/sitemap`             | NO   | 30/min/IP | URLs indexables (tenants activos + slugs de locales). Alimenta `app/sitemap.ts`                   |

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

## Operativa, productos, analytics y reports (Fase 6)

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

| Metodo | Ruta                                 | Auth | Descripcion                                                                                                             |
| ------ | ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/analytics/occupancy`               | SI   | Fisica + economica + MRR actual vs potencial + perFacility                                                              |
| GET    | `/analytics/churn?from=&to=`         | SI   | Cohort mensual. Default ultimos 6 meses                                                                                 |
| GET    | `/analytics/aging?atDate=`           | SI   | Buckets 0-30/30-60/60-90/+90 + totalOutstanding                                                                         |
| GET    | `/analytics/leads-funnel?from=&to=`  | SI   | Totales por estado + ratios + bySource                                                                                  |
| GET    | `/analytics/churn-risk`              | SI   | Riesgo de baja heurístico por contrato (score 0-100 + nivel + factores)                                                 |
| GET    | `/analytics/pricing-suggestions`     | SI   | Sugerencias de precio por ocupación (yield management, read-only)                                                       |
| GET    | `/analytics/forecast?months=`        | SI   | Previsión de MRR + ocupación a N meses (1-24, default 6) por tendencia                                                  |
| GET    | `/analytics/monthly-revenue?months=` | SI   | Ingresos por mes (histórico): facturado (emitido) y cobrado (pagos succeeded) de los últimos N meses (1-24, default 12) |
| GET    | `/analytics/leads-utm?from=&to=`     | SI   | Tracking de campañas: leads con UTM agrupados por (origen, campaña) + ganados + tasa de conversión                      |

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

| Metodo | Ruta                              | Auth       | Descripcion                                                                                                       |
| ------ | --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/tenants`                  | AdminGuard | Listado con filtros `?status=&plan=&search=`                                                                      |
| GET    | `/admin/tenants/:id`              | AdminGuard | Detalle + metricas + usuarios                                                                                     |
| POST   | `/admin/tenants/:id/suspend`      | AdminGuard | Cambia status → suspended                                                                                         |
| POST   | `/admin/tenants/:id/reactivate`   | AdminGuard | Cambia status → active                                                                                            |
| POST   | `/admin/tenants/:id/extend-trial` | AdminGuard | Body `{daysToAdd}`. Mueve `trialEndsAt`                                                                           |
| POST   | `/admin/tenants/:id/impersonate`  | AdminGuard | Devuelve access JWT con purpose='impersonation'                                                                   |
| POST   | `/admin/tenants/:id/anonymize`    | AdminGuard | RGPD: anonimiza customers + staff + PII del tenant, preserva invoices, marca cancelled+deletedAt. Body `{reason}` |
| GET    | `/admin/metrics`                  | AdminGuard | KPIs globales (MRR, tenants activos, churn)                                                                       |

### Endpoints — Support tickets

| Metodo | Ruta                                    | Auth        | Descripcion                               |
| ------ | --------------------------------------- | ----------- | ----------------------------------------- |
| GET    | `/support/tickets`                      | SI (tenant) | Lista del tenant                          |
| POST   | `/support/tickets`                      | SI (tenant) | Abre ticket                               |
| GET    | `/support/tickets/:id`                  | SI (tenant) | Detalle + mensajes (sin internal)         |
| POST   | `/support/tickets/:id/messages`         | SI (tenant) | Anade respuesta                           |
| GET    | `/admin/support/tickets`                | AdminGuard  | Lista global con filtros                  |
| GET    | `/admin/support/tickets/:id`            | AdminGuard  | Detalle + mensajes (incluye internal)     |
| POST   | `/admin/support/tickets/:id/messages`   | AdminGuard  | Anade mensaje, flag `isInternal` opcional |
| POST   | `/admin/support/tickets/:id/transition` | AdminGuard  | State machine                             |
| POST   | `/admin/support/tickets/:id/assign`     | AdminGuard  | Asigna a super admin                      |

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
- **Reenvio manual**: `POST /billing/invoices/:id/resend-aeat` resetea `aeat_*` y reencola.

### Endpoints — Credenciales AEAT del tenant

| Metodo | Ruta                           | Auth | Roles          | Descripcion                                                                          |
| ------ | ------------------------------ | ---- | -------------- | ------------------------------------------------------------------------------------ |
| POST   | `/billing/aeat-credentials`    | SI   | owner          | `multipart/form-data` con `file` (.p12/.pfx) + `password` + `environment` (max 50KB) |
| GET    | `/billing/aeat-credentials/me` | SI   | owner, manager | Metadata: CN, NIF, issuer, validFrom, validTo, environment, uploadedAt               |
| DELETE | `/billing/aeat-credentials/me` | SI   | owner          | Body `{reason}`. Revoca (`revokedAt`, `revokedReason`)                               |

### Endpoints — Reenvio factura

| Metodo | Ruta                                | Auth | Roles          | Descripcion                           |
| ------ | ----------------------------------- | ---- | -------------- | ------------------------------------- |
| POST   | `/billing/invoices/:id/resend-aeat` | SI   | owner, manager | Resetea `aeat_*` + reencola job (202) |

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
  `CryptoService`, `is_active`. Eventos permitidos: `invoice.created`,
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
- `GET /reviews` (`reviews:read`), `GET /reviews/stats` (`reviews:read`): NPS = %promotores(9-10) − %detractores(0-6), media de estrellas, tasa de respuesta.
- `GET /public/reviews/:token` + `POST /public/reviews/:token` (`@Public`, throttle, honeypot): contexto + envío de la valoración (NPS 0-10 + estrellas 1-5 + comentario) → emite `domain.review_submitted`.
- `GET/PATCH /settings/tenant/reviews` (`settings:read`/`settings:manage`): opt-in del cron `reviews.auto-request` (`reviews_auto_request` + `review_request_delay_days`).

### Promociones (`/promotions`)

- `GET/POST/PATCH/DELETE /promotions` (`promotions:read` / `promotions:manage`).
- `POST /promotions/validate` (`contracts:write`): previsualiza el descuento de un código sobre un precio mensual.
- Aplicación: `CreateContractSchema.promotionCode` en el alta de contrato → valida + fija `discount_amount` recurrente + `used_count++` (atómico). Solo percentage/fixed.

### Referidos (`/referrals`, `/portal/me/referrals`, `/settings/tenant/referrals`)

- `GET /referrals` + `GET /referrals/stats` (`referrals:read`): lista + métricas.
- `GET /portal/me/referrals` (`@Public` + sesión de portal): código del inquilino + sus referidos + recompensas.
- `GET/PATCH /settings/tenant/referrals` (`settings:read`/`settings:manage`): opt-in + recompensa (`referral_enabled`/`referral_reward_type`/`referral_reward_value`).
- Registro: `referralCode` en el alta de cliente (`CreateCustomerSchema`) y en el booking público (`PublicBookingSchema`). Conversión + recompensa (promoción `REF-XXXX` de un solo uso) por el listener `domain.contract_signed`.

### Campañas segmentadas (`/campaigns`)

- `POST /campaigns/preview` (`communications:send`): cuenta la audiencia (clientes/leads con email) de un `segment` sin crear ni enviar.
- `GET /campaigns` + `GET /campaigns/:id` (`communications:read`).
- `POST /campaigns` (`communications:send`): crea una campaña en borrador (segmento + asunto + cuerpo Handlebars inline).
- `POST /campaigns/:id/send` (`communications:send`): resuelve la audiencia, renderiza por destinatario y encola una `communications` por cada uno (`source=campaign:<id>`). Idempotente (409 `campaign_not_sendable` si no es borrador). v1 solo email.

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

- `GET /sepa/settings` (`settings:read`) + `PUT /sepa/settings` (`billing:configure`): config del acreedor (nombre, identificador, IBAN cifrado, BIC, enabled). El IBAN es opcional al actualizar (conserva el actual).
- `GET /sepa/mandates?customerId=` (`payments:read`) + `POST /sepa/mandates` (`payments:charge`) + `DELETE /sepa/mandates/:id` (`payments:charge`): mandatos por cliente (IBAN validado mod-97 + fecha de firma; crear cancela el activo previo).
- `POST /sepa/remittances/preview` (`invoices:manage`): facturas domiciliables (issued/overdue, cliente con mandato activo, sin remesa) + `withoutMandate`.
- `POST /sepa/remittances` (`invoices:manage`): genera el XML pain.008 + items (facturas quedan "en remesa", no pagadas aún). `GET /sepa/remittances` (`payments:read`).
- `GET /sepa/remittances/:id/xml` (`invoices:manage`): devuelve `{filename, xml}` (el front descarga el blob).
- `POST /sepa/remittances/:id/confirm` (`invoices:manage`): marca las facturas pagadas (methodType `sepa_debit`) + pasa los mandatos FRST→RCUR.

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

### Asistente IA (`/ai/...`)

- `POST /ai/chat` (`ai:use`): body `{ conversationId?, content }`. Crea la conversación si no se pasa id; el asistente puede invocar herramientas read-only (ocupación, vencidas, métricas, búsqueda/resumen de cliente) ejecutadas con el contexto del tenant. Devuelve `{ conversationId, message }` (con `toolsUsed`). 503 `ai_not_configured` si el provider anthropic no tiene API key.
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
