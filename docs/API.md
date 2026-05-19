# API

> Estado: **Fase 1B** — implementado el modulo de autenticacion. El resto de
> endpoints (facilities, units, etc.) llega en fases siguientes.

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

### Roles Postgres y RLS

La API usa dos conexiones distintas a Postgres:

- **`storageos_app`** (sometido a RLS) — para todas las queries que
  pueden usar el contexto del tenant del JWT. `PrismaService.withTenant`
  envuelve cada operacion en una transaccion que primero ejecuta
  `set_config('app.current_tenant', $1, true)`. Las politicas RLS hacen
  el filtrado automatico.

- **`storageos`** (bypass RLS por owner) — `PrismaAdminService`, usado
  para flujos sin tenant disponible: `register`, lookup de tenant por
  slug en `login`, y escritura de audit logs.

### Audit logs registrados

| Action               | Cuando                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `auth.register`      | Tras crear tenant + owner.                                                                      |
| `auth.login.success` | Login exitoso.                                                                                  |
| `auth.login.failed`  | Tenant existe pero email/password fallan. `changes.reason` ∈ `unknown_email`, `wrong_password`. |
| `auth.refresh`       | Refresh rotado correctamente.                                                                   |
| `auth.logout`        | Logout de una sesion.                                                                           |
| `auth.logout_all`    | Logout global; `changes.revokedCount`.                                                          |

Los intentos de login con **tenant inexistente** no se persisten (no hay
`tenant_id` para asociarlos). Quedan en el logger y se moveran a una
tabla `security_events` global en una fase futura.

### Rate limiting

`@nestjs/throttler` con un guard global. Por defecto 60/min/IP. Los
endpoints de autenticacion lo sobreescriben con presets declarados en
`apps/api/src/common/decorators/throttle-presets.ts`:

| Endpoint              | Limite                    |
| --------------------- | ------------------------- |
| `POST /auth/login`    | 5 requests / minuto / IP  |
| `POST /auth/register` | 3 requests / hora / IP    |
| `POST /auth/refresh`  | 30 requests / minuto / IP |

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
