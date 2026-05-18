# API

> Estado: **placeholder**. Se rellena cuando los primeros endpoints reales aparezcan en Fase 1.

## Convenciones (provisional)

- **Base path:** `/api/v1`. Versionado en la ruta.
- **Auth:** `Authorization: Bearer <access_token>` (JWT). El refresh va por cookie `httpOnly` + `secure` + `sameSite=strict`.
- **Tenant:** identificado por el access token; el guard `TenantContext` lo extrae y lo inyecta en cada request. Ningún endpoint acepta `tenant_id` como parámetro.
- **Formato:** JSON con `Content-Type: application/json; charset=utf-8`.
- **Casing:** `snake_case` en BD ↔ `camelCase` en la API. Prisma hace el mapping.
- **Paginación:** cursor-based por defecto. `?cursor=...&limit=...`. La respuesta incluye `nextCursor` y `hasMore`.
- **Filtros y orden:** `?filter[field]=value`, `?sort=field` o `?sort=-field` (descendente).
- **Errores:** envoltorio uniforme.
  ```json
  {
    "statusCode": 400,
    "error": "Bad Request",
    "message": "Validation failed",
    "details": [{ "field": "email", "issue": "invalid" }]
  }
  ```
- **Validación:** DTOs con `class-validator` en backend; los mismos schemas con Zod en `@storageos/shared` cuando aplique.
- **Rate limiting:** activo en `/auth/*`, `/payments/*` y endpoints de exportación.
- **Idempotencia:** mutaciones de pagos requieren `Idempotency-Key`.

## Health

| Método | Ruta      | Descripción                                |
| ------ | --------- | ------------------------------------------ |
| GET    | `/health` | Liveness probe. `{ status, timestamp }`.   |

## Pendiente

- Esquema OpenAPI exportado desde NestJS (`@nestjs/swagger`).
- Convenciones de webhooks salientes y de firma HMAC.
- Política de deprecación de versiones.
