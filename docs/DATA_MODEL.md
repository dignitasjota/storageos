# DATA_MODEL

Modelo de datos completo. Las tablas se implementan con Prisma sobre PostgreSQL 16.

> **Estado de implementación (2026-05-19):** las secciones **1. Núcleo de tenancy** y **1bis. Auth** están implementadas (Fases 1A–1F). Las secciones **2 a 10** son la **especificación de destino** del MVP; sus tablas se irán creando con la migración correspondiente cuando la fase llegue. La fuente de verdad de lo que existe ahora mismo es [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma); este documento describe **a dónde vamos**.

## Convenciones generales

- Toda tabla (salvo `tenants`, `subscription_plans` y tablas de configuración global) lleva `tenant_id` con FK e índice.
- Todas las tablas llevan `id` (UUID v7 generado por `uuid_generate_v7()`, ver sección "Identidad y multi-tenancy"), `created_at`, `updated_at` (timestamptz).
- Soft delete con `deleted_at` solo en tablas donde sea necesario (customers, contracts, invoices).
- Nombres en snake_case en BBDD, camelCase en Prisma con `@map`.
- Enums en Postgres mediante tipos enumerados de Prisma.
- Row-Level Security activado en todas las tablas con `tenant_id`.

## Identidad y multi-tenancy (Fase 1A)

### UUID v7

Todos los `id` se generan con la función SQL `uuid_generate_v7()` definida en la migración `20260518230000_uuidv7_function`. Implementación en plpgsql, sin dependencias externas (usa `gen_random_bytes` de `pgcrypto`).

- 48 bits de timestamp ms + 4 bits versión (7) + 12 bits aleatorios + 2 bits variant RFC 4122 + 62 bits aleatorios.
- **Ventaja**: orden cronológico aproximado → menos fragmentación en índices B-tree.
- **Garantía de monotonía**: entre milisegundos distintos. Dentro del mismo ms, el orden no está garantizado (los bits aleatorios pueden romperlo). Tests en `packages/database/tests/uuid-v7.test.ts`.

### Roles de base de datos

| Rol             | Propósito                                                              | RLS            |
| --------------- | ---------------------------------------------------------------------- | -------------- |
| `storageos`     | Admin / owner de las tablas. Lo usa Prisma para migraciones y el seed. | Bypass (owner) |
| `storageos_app` | Rol restringido para la aplicación (apps/api). Sin DDL.                | Sometido       |

El usuario de la app **NO puede ejecutar DDL** ni bypassear RLS. Cualquier intento de leer/escribir datos fuera del tenant actual es rechazado por Postgres con error `42501`.

### Row-Level Security

Tablas con RLS activado al cierre de Fase 1F:

- `tenants` (filtro por `id`)
- `users`, `tenant_subscriptions`, `audit_logs`, `sessions`, `email_verification_tokens`, `password_reset_tokens`, `invitations`, `recovery_codes` (filtro por `tenant_id`)

Tablas SIN RLS:

- `subscription_plans` (catálogo global)
- `_prisma_migrations` (Prisma)

Política aplicada a cada tabla bajo RLS:

```sql
CREATE POLICY tenant_isolation ON <tabla>
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

### Establecer el tenant context desde la app

La extensión Prisma de `@storageos/database` expone `withTenantContext`:

```ts
import { withTenantContext } from '@storageos/database';

const users = await withTenantContext(prisma, tenantId, (tx) => tx.user.findMany());
```

Internamente envuelve la operación en una `$transaction` y ejecuta:

```sql
SELECT set_config('app.current_tenant', $1, true);
```

El tercer argumento `true` hace el valor local a la transacción → se descarta al commit/rollback → no hay fugas entre requests aunque se reutilicen conexiones del pool.

> **Importante:** todo flujo que conecte como `storageos_app` debe ir dentro de `withTenantContext`. Sin él, **toda query devuelve 0 filas** (deny by default).

## 1. Núcleo de tenancy

### `tenants`

Empresas clientes del SaaS.

- id, name, slug (único), status (trial/active/suspended/cancelled), trial_ends_at, billing_email, country, locale, currency, timezone, tax_id, created_at

### `users`

Staff interno del tenant.

- `id`, `tenant_id`, `email` (único por tenant), `password_hash` (argon2id), `full_name`, `phone`, `role` (owner/manager/staff/readonly), `email_verified_at`, `two_factor_secret` (cifrado AES-256-GCM, ver ADR-015), `two_factor_pending_secret` (cifrado; setado durante el flujo de enrolment, se mueve a `two_factor_secret` al verificar), `two_factor_enabled`, `two_factor_enrolled_at`, `last_login_at`, `is_active`.

**Invariantes** (Fase 1E):

- Exactamente **un user con role `owner`** por tenant. Garantizado por el servicio: `PATCH /users/:id` rechaza cambiar el role del owner (`code: owner_required`) y `POST /users/:id/transfer-ownership` hace el swap en una sola transacción.
- `manager` no puede asignar `manager` a otro user; solo el `owner` puede (`code: insufficient_role`).
- Soft delete vía `is_active = false` (revoca todas las sesiones del user; no hay borrado físico desde la UI).

### `subscription_plans`

Planes que vendemos como super admin (sin tenant_id, global).

- id, name, slug, price_monthly, price_yearly, max_units, max_facilities, max_users, features (jsonb), is_active

### `tenant_subscriptions`

Suscripción activa de cada tenant.

- id, tenant_id, plan_id, status, current_period_start, current_period_end, stripe_subscription_id, cancel_at_period_end

## 1bis. Auth (Fases 1B, 1D, 1E, 1F)

Tablas que soportan login, refresh, verificación de email, password recovery, invitaciones y 2FA. Todas con RLS.

### `sessions` (Fase 1B)

Cada login emite una sesión. Cada refresh rota la actual (la marca `revokedReason: rotated`) y crea otra apuntando con `rotated_from_id`.

- `id`, `tenant_id`, `user_id`, `refresh_token_hash` (argon2id de `secret`), `user_agent`, `ip_address` (inet), `expires_at`, `last_used_at`, `revoked_at`, `revoked_reason` (`logout` | `rotated` | `refresh_reuse` | `password_changed` | `password_reset`), `rotated_from_id` (FK self).
- Detección de reuso paranoid: ver ADR-014.

### `email_verification_tokens` (Fase 1D)

Token que viaja en el enlace del email de verificación tras `/auth/register` o `/auth/resend-verification`. Plaintext `<id>.<secret>`; solo el hash argon2id del secret se persiste. Single-use.

- `id`, `tenant_id`, `user_id`, `token_hash`, `expires_at`, `used_at`.

### `password_reset_tokens` (Fase 1D)

Mismo formato que el anterior. TTL más corto (1 h por defecto). Al usarse, **se revocan todas las sesiones del user** con `revokedReason: password_reset`.

- `id`, `tenant_id`, `user_id`, `token_hash`, `expires_at`, `used_at`, `requested_ip`, `requested_user_agent`.

### `invitations` (Fase 1E)

Única vía para crear nuevos users del tenant. Token plaintext `<invitationId>.<secret>` en el enlace del email; hash argon2id en BD. Single-use atómico (`updateMany` con `WHERE accepted_at IS NULL AND revoked_at IS NULL`). TTL 7 días.

- `id`, `tenant_id`, `email`, `role` (manager/staff/readonly; no `owner`), `invited_by_user_id`, `token_hash`, `expires_at`, `accepted_at`, `revoked_at`, `revoked_reason` (`manual` | `replaced_by_resend`).
- Índice único parcial `(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL` — solo una pendiente por email/tenant. Implementado en SQL crudo en la migración 1E (Prisma no soporta `WHERE` en `@@unique`).
- Al aceptar (`POST /invitations/token/:token/accept`), se crea el `user` con `email_verified_at = now()` y se emite sesión normal.
- `resend` revoca la invitación original con `revokedReason: replaced_by_resend` y crea una nueva fila con token nuevo.

### `recovery_codes` (Fase 1F)

10 códigos de recuperación de 2FA por user. Hash argon2id, single-use atómico.

- `id`, `tenant_id`, `user_id`, `code_hash`, `used_at`.
- `issueForUser` borra los previos del user en transacción (regenerar invalida los anteriores).
- `consume` itera sobre los códigos no usados, hace `argon2.verify` y marca con `updateMany WHERE id = $1 AND used_at IS NULL` (resuelve carreras).

## 2. Instalaciones físicas y trasteros

### `facilities`

Locales físicos del tenant.

- id, tenant_id, name, address, city, postal_code, country, latitude, longitude, timezone, opening_hours (jsonb), contact_phone, contact_email, is_active

### `facility_floors`

Plantas dentro de un local (opcional).

- id, facility_id, name, floor_number, plan_image_url, plan_width_px, plan_height_px

### `unit_types`

Tipologías de trastero del tenant.

- id, tenant_id, name, description, default_price_monthly, color (hex, para visualización), features (jsonb: climatizado, vigilancia, etc.)

### `units`

Cada trastero individual.

- id, tenant_id, facility_id, floor_id (nullable), unit_type_id, code (único por facility), width_m, depth_m, height_m, area_m2 (calculado), volume_m3 (calculado), status (available/occupied/reserved/maintenance/blocked), base_price_monthly, plan_x, plan_y, plan_width, plan_height, plan_shape (jsonb, para polígonos), notes

> `area_m2` y `volume_m3` se implementan como columnas `GENERATED ALWAYS AS` en Postgres para garantizar coherencia (no se pueden setear desde la app).

### `unit_status_history`

Auditoría de cambios de estado.

- id, unit_id, previous_status, new_status, changed_by_user_id, reason, occurred_at

## 3. Pricing

### `pricing_rules`

Reglas de pricing dinámico.

- id, tenant_id, name, scope (unit/unit_type/facility/tenant), target_id, type (seasonal/occupancy_based/duration_discount), conditions (jsonb), price_modifier_type (percentage/fixed), price_modifier_value, valid_from, valid_until, priority, is_active

### `promotions`

Códigos promocionales.

- id, tenant_id, code (único por tenant), name, discount_type, discount_value, applies_to (jsonb), max_uses, used_count, valid_from, valid_until, is_active

## 4. Inquilinos finales

### `customers`

Inquilinos del tenant.

- id, tenant_id, customer_type (individual/business), first_name, last_name, company_name, document_type, document_number, email, phone, address, city, postal_code, country, emergency_contact_name, emergency_contact_phone, notes, tags (array), portal_access_enabled, portal_password_hash, kyc_verified, kyc_verified_at, deleted_at

### `customer_documents`

Archivos del cliente.

- id, customer_id, type (id_front/id_back/proof_of_address/other), file_url (MinIO), file_name, mime_type, file_size, uploaded_by_user_id, expires_at

## 5. Contratos y reservas

### `contracts`

Contratos de alquiler.

- id, tenant_id, customer_id, unit_id, contract_number (único por tenant), status (draft/active/ending/ended/cancelled), start_date, end_date (nullable si indefinido), billing_cycle (monthly/weekly/daily), price (la facturada), deposit_amount, deposit_status (none/held/returned/partially_returned), signed_at, signed_pdf_url, signature_provider, auto_renew, cancellation_notice_days, notes, deleted_at

### `contract_events`

Historial del contrato.

- id, contract_id, event_type (created/signed/price_changed/unit_changed/paused/resumed/ended), payload (jsonb), created_by_user_id, occurred_at

### `reservations`

Reservas previas a la firma.

- id, tenant_id, unit_id, customer_id (nullable), lead_id (nullable), status (pending/confirmed/expired/converted/cancelled), reserved_until, deposit_paid, deposit_amount, notes

## 6. Facturación y pagos

### `invoices`

- id, tenant_id, customer_id, contract_id (nullable, p.ej. ventas sueltas), invoice_number (único por tenant, secuencial conforme a normativa), issue_date, due_date, status (draft/issued/sent/paid/overdue/cancelled/refunded), subtotal, tax_amount, total, currency, pdf_url, notes, deleted_at

### `invoice_items`

- id, invoice_id, description, quantity, unit_price, tax_rate, tax_amount, total, related_contract_id, related_product_id, period_start, period_end

### `payments`

- id, tenant_id, invoice_id, customer_id, amount, currency, method (card/sepa/cash/transfer/other), status (pending/processing/succeeded/failed/refunded), gateway (stripe/gocardless/redsys/manual), gateway_payment_id, gateway_response (jsonb), paid_at, refunded_at, failure_reason

### `payment_methods`

Métodos guardados del cliente.

- id, customer_id, type (card/sepa), gateway, gateway_token, last4, brand, exp_month, exp_year, is_default, mandate_reference

### `dunning_actions`

Gestión de impagos.

- id, invoice_id, action_type (email_reminder/sms_reminder/late_fee/access_block/legal_notice), scheduled_for, executed_at, result, notes

## 7. Control de accesos físicos

### `access_credentials`

Credenciales de acceso.

- id, tenant_id, customer_id, contract_id, type (pin/qr/nfc/app), value_hash, valid_from, valid_until, is_active, revoked_at, revoked_reason

### `access_logs`

Registro de accesos.

- id, tenant_id, facility_id, unit_id (nullable), customer_id (nullable), credential_id (nullable), access_type (facility_entry/facility_exit/unit_open), granted (boolean), denial_reason, device_id, occurred_at

### `access_devices`

Dispositivos físicos.

- id, tenant_id, facility_id, unit_id (nullable), device_type (gate/keypad/smart_lock/qr_reader), vendor, model, external_id, status (online/offline/error), last_seen_at, config (jsonb)

## 8. CRM y comunicaciones

### `leads`

- id, tenant_id, facility_id (nullable), name, email, phone, source, interested_unit_type_id (nullable), message, status (new/contacted/visit_scheduled/quoted/converted/lost), assigned_to_user_id, converted_to_customer_id (nullable), lost_reason

### `communications`

Log unificado de mensajes.

- id, tenant_id, customer_id (nullable), lead_id (nullable), channel (email/sms/whatsapp/internal_note), direction (in/out), subject, body, status (queued/sent/delivered/opened/failed), provider_message_id, sent_at, opened_at, error

### `message_templates`

- id, tenant_id, name, channel, subject, body, variables (jsonb), category, is_active

### `automation_rules`

- id, tenant_id, name, trigger_event, conditions (jsonb), actions (jsonb), is_active, last_run_at

## 9. Operativa interna

### `tasks`

- id, tenant_id, facility_id (nullable), unit_id (nullable), customer_id (nullable), assigned_to_user_id, title, description, priority (low/medium/high/urgent), status (open/in_progress/done/cancelled), due_date, completed_at, created_by_user_id

### `incidents`

- id, tenant_id, facility_id, unit_id (nullable), reported_by_user_id, type (water_damage/lock_broken/cleaning/security/other), description, severity (low/medium/high/critical), status (open/in_progress/resolved/closed), photos (array de URLs MinIO), resolved_at, resolution_notes

### `products`

Productos accesorios para venta.

- id, tenant_id, name, sku, description, price, tax_rate, stock, is_active

### `product_sales`

- id, tenant_id, customer_id (nullable), invoice_id (nullable), product_id, quantity, unit_price, total, sold_at, sold_by_user_id

## 10. Auditoría e integraciones

### `audit_logs`

- id, tenant_id, user_id (nullable), action, entity_type, entity_id, changes (jsonb con before/after), ip_address, user_agent, occurred_at

### `api_keys`

- id, tenant_id, name, key_prefix, key_hash, scopes (array), last_used_at, expires_at, revoked_at, created_by_user_id

### `webhooks`

- id, tenant_id, url, events (array), secret, is_active, last_success_at, last_failure_at, failure_count

### `webhook_deliveries`

- id, webhook_id, event_type, payload (jsonb), response_status, response_body, attempt_count, delivered_at, failed_at

## Índices clave

- Todas las FK con índice.
- Compuesto `(tenant_id, ...)` en todas las queries habituales.
- `units (facility_id, status)` para vistas de plano.
- `invoices (tenant_id, status, due_date)` para dunning.
- `access_logs (tenant_id, occurred_at DESC)` para auditoría.
- Búsqueda full-text en `customers (full_name, email, phone, document_number)`.

## Reglas de integridad y negocio

- Un `unit` solo puede tener un `contract` activo (status `active` o `ending`) en un momento dado.
- `unit.status` se actualiza por trigger o servicio cuando cambia el estado de su contrato.
- `invoice_number` es secuencial e inmutable una vez emitida (requisito fiscal en España).
- `access_credentials` se desactivan automáticamente si el contrato se cierra o si hay `dunning_action` de tipo `access_block` activa.
- Borrar un `customer` con contratos activos no está permitido; se hace soft delete.
- La timezone de las fechas mostradas es la del `facility` correspondiente; las almacenadas siempre UTC.

## Pendiente — Fase 4 — Verifactu (RD 1007/2023)

España exige Verifactu para sociedades desde el 1 de enero de 2026. El MVP de StorageOS debe ser compliant. Cambios a aplicar cuando se implemente la facturación:

### `invoices` — campos adicionales

- `hash` (text) — hash de la propia factura, calculado conforme al algoritmo Verifactu.
- `previous_hash` (text, nullable) — hash de la factura inmediatamente anterior de la misma serie, para encadenamiento criptográfico. `NULL` solo en la primera factura de cada serie.
- `qr_code_url` (text) — URL del QR obligatorio en la factura (apunta a la AEAT con los datos clave).
- `verifactu_mode` (enum: `verifactu` | `no_verifactu`) — modalidad declarada por el tenant.
- `aeat_sent_at` (timestamptz, nullable) — momento de envío.
- `aeat_status` (enum: `pending` | `accepted` | `accepted_with_warnings` | `rejected` | `error`) — resultado del envío.
- `aeat_response` (jsonb, nullable) — payload de respuesta para diagnóstico.
- `aeat_csv` (text, nullable) — Código Seguro de Verificación devuelto por la AEAT cuando aplica.

### `invoice_series` — nueva tabla

Para soportar múltiples series por tenant (p. ej. una por facility o por año):

- `id`, `tenant_id`, `code` (único por tenant), `name`, `prefix`, `year_scope` (boolean), `next_number`, `facility_id` (nullable), `is_active`.

### `audit_logs` — convención

Toda emisión de factura genera un `audit_log` con el hash y el `aeat_status` final. Sin excepciones.

## Pendiente — RGPD

Para cumplir el derecho de acceso, rectificación, supresión y portabilidad:

### `data_subject_requests`

- `id`, `tenant_id`, `customer_id` (nullable si el sujeto no es cliente registrado), `email`, `request_type` (`access` | `rectification` | `erasure` | `portability` | `restriction`), `status` (`open` | `in_progress` | `fulfilled` | `denied`), `submitted_at`, `due_at` (calculado: 1 mes desde submitted_at), `fulfilled_at`, `notes`, `handled_by_user_id`.

### `consents`

Registra los consentimientos explícitos (marketing, comunicaciones no esenciales, etc.):

- `id`, `tenant_id`, `customer_id`, `purpose` (string), `granted` (boolean), `granted_at`, `revoked_at`, `evidence` (jsonb con IP, user-agent, texto exacto del consentimiento).
