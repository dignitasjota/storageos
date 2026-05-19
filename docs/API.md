# API

> Estado: **Fase 4** — autenticacion (Fase 1), gestion fisica (Fase 2),
> operativa de contratos (Fase 3) y \*\*facturacion + pagos + dunning + RGPD
>
> - portal del inquilino\*\* (Fase 4: invoices con Verifactu hash encadenado,
>   Stripe gateway, BullMQ recurrente, anonimizacion RGPD compatible con
>   obligacion fiscal, magic link login para el cliente final).

## Convenciones

- **Base path actual:** las rutas estan en la raiz (`/auth/...`, `/health`).
  Cuando montemos el versionado, se moveran a `/api/v1`.
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

| Metodo | Ruta      | Auth | Descripcion                              |
| ------ | --------- | ---- | ---------------------------------------- |
| GET    | `/health` | NO   | Liveness probe. `{ status, timestamp }`. |

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

Devuelve `{ user, tenant, subscription }` del usuario autenticado.

- `200 OK`.
- `401 Unauthorized` sin token o con token invalido/expirado.

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

| Metodo | Ruta                    | Auth | Throttle  | Descripcion                                   |
| ------ | ----------------------- | ---- | --------- | --------------------------------------------- |
| POST   | `/portal/login/request` | NO   | 5/min/IP  | Envia magic link al email (204 silencioso)    |
| POST   | `/portal/login/consume` | NO   | 5/min/IP  | Intercambia token por JWT corto (single-use)  |
| GET    | `/portal/me/invoices`   | NO   | 60/min/IP | Bearer JWT portal; lista facturas del cliente |

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

## Pendiente

- Versionado en la ruta (`/api/v1/...`).
- Esquema OpenAPI exportado desde NestJS (`@nestjs/swagger`).
- Convenciones de paginacion cursor-based con ejemplos.
- Convenciones de webhooks salientes + firma HMAC.
- Politica de deprecacion de versiones.
- Tabla `security_events` para login-failed sin tenant (Fase 8).
