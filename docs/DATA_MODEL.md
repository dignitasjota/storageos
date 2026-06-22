# DATA_MODEL

Modelo de datos completo. Las tablas se implementan con Prisma sobre PostgreSQL 16.

> **Estado de implementación (2026-05-20):** **MVP cerrado (Fases 1-14)**. Todas las tablas descritas en las secciones 1-14 están implementadas. La sección **15. Pendiente / post-MVP** lista lo que queda fuera del MVP. Fuente de verdad: [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma); este documento explica el **por qué** de cada tabla y sus invariantes.

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
- **Fase 12A.1**: `require_two_factor_for_managers BOOLEAN DEFAULT false`. Cuando `true`, todos los users con role `owner`/`manager` quedan obligados a tener 2FA activo; el `/auth/login` les devuelve un `enrolmentToken` corto en lugar de access/refresh hasta que se enrolen. Solo el `owner` puede modificar este flag (`PATCH /settings/tenant/security`).
- **Auto-charge (2026-06-11)**: `auto_charge_on_issue BOOLEAN DEFAULT false`. Cuando `true`, al emitir una factura se encola un cobro automático al método de pago predeterminado del cliente (cola BullMQ `payments`, listener de `domain.invoice_issued`). Solo el `owner` puede modificarlo (`PATCH /settings/tenant/billing`).
- **Recargo por mora (2026-06-22)**: `late_fee_enabled BOOLEAN DEFAULT false` (opt-in) + `late_fee_type TEXT DEFAULT 'percentage'` (percentage/fixed) + `late_fee_value DECIMAL(10,2) DEFAULT 5` + `late_fee_grace_days INT DEFAULT 7`. El dunning emite una factura separada de recargo a los N días de vencimiento. `GET/PATCH /settings/tenant/billing` (`billing:configure`). El enlace está en `invoices.late_fee_for_invoice_id` (FK self, único parcial → idempotencia).
- **Reviews/NPS (2026-06-22)**: `reviews_auto_request BOOLEAN DEFAULT false` + `review_request_delay_days INT DEFAULT 14`. Opt-in del cron `reviews.auto-request` que pide la valoración N días tras firmar. `GET/PATCH /settings/tenant/reviews` (`settings:read`/`settings:manage`).
- **Referidos (2026-06-22)**: `referral_enabled BOOLEAN DEFAULT false` + `referral_reward_type promotion_discount_type DEFAULT 'fixed'` + `referral_reward_value DECIMAL(10,2) DEFAULT 0`. Opt-in del programa de referidos; la recompensa (percentage/fixed) se materializa como una promoción de un solo uso al convertir. `GET/PATCH /settings/tenant/referrals`.

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
- `public_slug` (único por tenant, autogenerado del nombre): identificador en la landing SEO `/s/<tenant>/<slug>`. Editable desde la pestaña "Ajustes" del local.
- **Imágenes (2026-06-22)**: `images TEXT[] DEFAULT '{}'` — **keys** de objeto MinIO (no URLs del cliente) de las imágenes que se muestran en la landing pública. Se sirven desde el bucket **público dedicado** `storageos-public` (anonymous download); el resto de buckets (`uploads`/`invoices`/`plans`) son privados. `POST /facilities/:id/images/upload-url` (presigned PUT) + `PUT /facilities/:id/images` (valida que cada key empieza por `<tenant>/<facility>/images/`).

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

- id, tenant_id, code (único por tenant), name, discount_type (percentage/fixed/free_months), discount_value, applies_to (jsonb), max_uses, used_count, valid_from, valid_until, is_active
- **Gestión + aplicación (2026-06-22)**: CRUD `/promotions` (`promotions:read`/`promotions:manage`) + `POST /promotions/validate`. Se aplica en el alta de contrato vía `CreateContractSchema.promotionCode` → fija `contracts.discount_amount` recurrente + incrementa `used_count` (atómico, en la transacción). Solo percentage/fixed en alta. Las **recompensas de referidos** se generan como promociones `REF-XXXX` de un solo uso (`max_uses=1`).

## 4. Inquilinos finales

### `customers`

Inquilinos del tenant.

- id, tenant_id, customer_type (individual/business), first_name, last_name, company_name, document_type, document_number, email, phone, address, city, postal_code, country, emergency_contact_name, emergency_contact_phone, notes, tags (array), portal_access_enabled, portal_password_hash, kyc_verified, kyc_verified_at, deleted_at
- **Referidos (2026-06-22)**: `referral_code TEXT` (índice único parcial por tenant, autogenerado 8 chars sin ambiguos al verlo en el portal). Es el código que el inquilino comparte para referir a otros.

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

- id, tenant_id, `customer_id` (**NULLABLE desde Fase 13A.3** para soportar F2 sin destinatario identificado), contract_id (nullable, p.ej. ventas sueltas), invoice_number (único por tenant, secuencial conforme a normativa), issue_date, due_date, status (draft/issued/sent/paid/overdue/cancelled/refunded), subtotal, tax_amount, total, currency, pdf_url, notes, deleted_at
- **Fase 11A.4 + 13A.3 — Tipo de factura y rectificativas**:
  - `invoice_type` (enum `F1 | F2 | R1 | R2 | R3 | R4 | R5`, default `F1`). F1 = completa con destinatario; F2 = simplificada (sin destinatario obligatorio, limites AEAT 400€/3000€). R1-R5 = rectificativas según causa AEAT.
  - `rectifies_invoice_id` (UUID, FK self, nullable). Apunta a la factura que está rectificando (solo en R1-R5).
  - `rectification_reason` (text, nullable). Obligatorio en R1-R5; queda en el XML AEAT.
  - `correction_method` (enum `by_differences | by_substitution`, nullable). En el XML AEAT mapea a `<TipoRectificativa>I</TipoRectificativa>` (diferencias, Fase 11A.4) o `<TipoRectificativa>S</TipoRectificativa>` (sustitución, Fase 13A.3) con bloque `<ImporteRectificacion>`.
  - `simplified_justification` (enum `reparation | transport | restaurant | parking | other`, nullable). Solo en F2 cuando el total excede 400€ (permite hasta 3000€). El XML emite `<FacturaSinIdentifDestinatarioArt61d>S</...>` cuando no hay `customer_id`.

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
- El enum `automation_trigger` añadió en 2026-06-22 los valores `review_request` y `review_submitted` (ciclo de valoración NPS).

### `reviews` (2026-06-22)

Valoraciones (NPS) del inquilino post-contratación. RLS por `tenant_id`.

- id, tenant_id, customer_id, contract_id (nullable), `token` (único, enlace público), token_expires_at, status (pending/submitted/expired), `nps_score` (0-10), `rating` (1-5), comment, channel (email/whatsapp/manual), source, requested_at, submitted_at, ip, user_agent
- Solicitud manual (`POST /reviews/request`) o cron `reviews.auto-request`. Pública por token: `GET/POST /public/reviews/:token`. Stats NPS en `GET /reviews/stats`. Permiso nuevo `reviews:read`/`reviews:write`.

### `referrals` (2026-06-22)

Programa de referidos. RLS por `tenant_id`.

- id, tenant_id, referrer_customer_id, referred_customer_id (**único** — un cliente se refiere una vez), status (pending/converted/cancelled), reward_promotion_id (FK a `promotions`, nullable), converted_at, created_at
- Se registra en el alta del referido (best-effort, en la transacción). El listener `domain.contract_signed` lo marca `converted` + genera la promoción-recompensa. Vista del portal `GET /portal/me/referrals`, panel `GET /referrals` (permiso `referrals:read`).

### `campaigns` (2026-06-22)

Campañas segmentadas por email. RLS por `tenant_id`.

- id, tenant_id, name, channel (email), subject, body_text, `segment` jsonb (audiencia clientes/leads + filtros), status (draft/sending/sent/cancelled), audience_count, sent_count, scheduled_for, sent_at, created_by_user_id
- Al enviar (`POST /campaigns/:id/send`) se resuelve la audiencia (con `withTenant`) y se encola una `communications` por destinatario (`source=campaign:<id>`, subject/body renderizados por destinatario). Permisos `communications:read`/`communications:send`.

### `rent_increases` + `rent_increase_items` (2026-06-22)

Subidas de precio a clientes en cartera (ECRI). RLS por `tenant_id`.

- **`rent_increases`** (la tanda): id, tenant_id, name, `scope` jsonb (antigüedad mínima + local/tipo), increase_type (percentage/fixed), increase_value, effective_date, status (scheduled/applied/cancelled), affected_count, applied_count, mrr_delta, notice_sent, created_by_user_id, applied_at
- **`rent_increase_items`** (por contrato, congela el cambio): id, tenant_id, rent_increase_id (FK), contract_id (FK), old_price, new_price, status (pending/applied/skipped), skip_reason, applied_at. Único `(rent_increase_id, contract_id)`.
- Al crear se congelan los items + se envía el preaviso por email. El cron `rent-increases.apply` (o el botón manual) aplica en `effective_date`: `contract.price_monthly = new_price` + `contract_event 'price_changed'`. La facturación recurrente lee `price_monthly`. Permiso `contracts:manage`.

### `insurance_plans` (2026-06-22)

Planes de seguro / protección de contenido (catálogo del tenant). RLS por `tenant_id`.

- id, tenant_id, name, monthly_price, coverage_amount, tax_rate (default 21), description, is_active
- Se asigna a un contrato vía `contracts.insurance_plan_id` (FK SET NULL) + `contracts.insurance_price` (**snapshot** de la prima al asignar). La facturación recurrente añade una línea de la prima a la factura mensual del alquiler. CRUD `/insurance-plans` (permisos `insurance:read`/`insurance:manage`); asignación `PUT /contracts/:id/insurance` (`contracts:write`).

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

- id, tenant_id, user_id (nullable), action, entity_type, entity_id, changes (jsonb con before/after), ip_address, user_agent, occurred_at.
- RLS por `tenant_id`.

### `security_events` (Fase 11A.1)

Tabla **global**, sin `tenant_id`, **sin RLS**. Acceso exclusivo via `PrismaAdminService`. Recoge intentos de auth fallidos cuando aún no hay tenant context (email inexistente, tenant inexistente, throttled, etc.) y otros eventos de seguridad transversales.

- `id`, `event_type`, `email_attempted` (nullable), `tenant_slug_attempted` (nullable), `ip_address`, `user_agent`, `metadata` (jsonb, p.ej. `{ reason, route, ... }`), `created_at`.
- `SecurityEventsService.record()` es **defensivo**: cualquier error al persistir se loguea pero no rompe el flujo de auth.
- Eventos registrados: `login_failed_email_not_found`, `login_failed_tenant_not_found`, `login_failed_wrong_password`, `login_failed_throttled`, `register_throttled`, `password_reset_throttled`, `invitation_token_invalid`, `refresh_token_reuse`.
- Cron diario `0 3 * * *` borra eventos con `created_at < now() - interval '90 days'`.

### `api_keys` (Fase 14A.3)

Credenciales programáticas por tenant. RLS por `tenant_id`.

- `id`, `tenant_id`, `name`, `key_prefix` (12 primeros chars del plaintext, para mostrar en UI), `key_hash` (argon2id del `secret`), `scopes` (text[]), `last_used_at`, `revoked_at`, `created_at`, `created_by_user_id`.
- Plaintext del token: `sk_live_<tenantId>.<secret>`. Sólo el hash del `secret` se persiste; el plaintext se devuelve **una sola vez** en `POST /settings/api-keys`.
- `scopes`: whitelist tipo `invoices:read`, `customers:write`, `*`. La validación de scope la hace el guard del endpoint correspondiente.
- `ApiKeyGuard` extrae `Authorization: Bearer sk_live_*`, hace lookup por prefix + `argon2.verify` del secret, actualiza `last_used_at` y rellena el request context con `{ tenantId, apiKeyId, scopes }`.

### `webhooks` (Fase 14A.3)

Webhooks salientes por tenant. RLS por `tenant_id`.

- `id`, `tenant_id`, `name`, `url`, `secret` (cifrado AES-256-GCM con `CryptoService` y `MASTER_ENCRYPTION_KEY`), `events` (text[]), `is_active`, `created_at`, `revoked_at`.
- `events` está restringido a la whitelist: `invoice.created`, `invoice.paid`, `invoice.overdue`, `contract.signed`, `lead.created`. Cualquier valor fuera de ella devuelve `400 webhook_event_invalid`.
- `url` validada: solo `https://...`, rechazada si resuelve a IPs privadas (defensa contra SSRF interno).
- `POST /settings/webhooks/:id/rotate-secret` genera un secret nuevo y devuelve plaintext una vez.

### `webhook_deliveries` (Fase 14A.3)

Cada intento de entrega genera una fila. RLS por `tenant_id`.

- `id`, `tenant_id`, `webhook_id`, `event_type`, `payload` (jsonb), `signature`, `attempts`, `status` (`pending | success | failed`), `status_code`, `response_body`, `error_message`, `scheduled_for`, `delivered_at`, `created_at`.
- Índices: `(tenant_id, status)` para listados y `(webhook_id, created_at desc)` para el histórico del webhook.

**HMAC**: header `X-Storageos-Signature: t=<unix_ts>,v1=<hmacSha256Hex>` sobre `${ts}.${rawBody}`. Headers extra `X-Storageos-Event`, `X-Storageos-Delivery`.

**Retry**: cola BullMQ `webhooks`, job `deliver`, `attempts: 3, backoff: exponential 60s`. Si HTTP retorna 2xx → `status='success'`. Error técnico o status ≥ 500 → throw → BullMQ reintenta. Tras 3 intentos fallidos → `status='failed'` y no se reintenta hasta reenvío manual.

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

## 11. Verifactu (Fase 4 + Fase 10)

España exige Verifactu para sociedades desde 2026-07-01. Implementado.

### `invoices` — campos Verifactu

- `hash` (text) — SHA-256 de la propia factura.
- `previous_hash` (text, nullable) — hash de la factura inmediatamente anterior de la misma serie. `NULL` solo en la primera factura de cada serie.
- `qr_code_url` (text) — URL del QR AEAT embebido en el PDF.
- `verifactu_mode` (enum: `verifactu` | `no_verifactu`) — modalidad declarada.
- `aeat_sent_at` (timestamptz, nullable).
- `aeat_status` (enum: `pending` | `accepted` | `accepted_with_warnings` | `rejected` | `error`).
- `aeat_response` (jsonb, nullable) — payload de respuesta + diagnóstico (`raw` AEAT + `mode`).
- `aeat_csv` (text, nullable) — Código Seguro de Verificación devuelto por AEAT.

### `invoice_series`

- `id`, `tenant_id`, `code` (único por tenant), `name`, `prefix`, `year_scope` (boolean), `next_number`, `facility_id` (nullable), `is_active`.

### `tenant_aeat_credentials` (Fase 10 + Fase 11A.2)

Histórico de PKCS#12 por tenant. **Fase 11A.2 elimina la restricción `UNIQUE` sobre `tenant_id`** para permitir conservar las credenciales revocadas como auditoría de rotaciones.

- `id`, `tenant_id` (sin UNIQUE), `cert_p12_encrypted` (bytea, AES-256-GCM via `CryptoService` con `MASTER_ENCRYPTION_KEY`), `cert_password_encrypted` (text), `cert_common_name`, `cert_nif`, `cert_issuer`, `cert_valid_from`, `cert_valid_to`, `environment` (`sandbox`|`production`), `uploaded_by_id`, `uploaded_at`, `revoked_at`, `revoked_reason`.
- **Credencial activa**: la única fila del tenant con `revoked_at IS NULL`. El upload nuevo hace `updateMany { revokedAt: null } → set revokedAt: now()` + `create new` dentro de una `$transaction` (atómico). `DELETE /billing/aeat-credentials/me` setea `revoked_at` con motivo, no borra físicamente.
- Endpoint `GET /billing/aeat-credentials/history` (owner/manager) lista todas las filas (activa + revocadas) cronológicamente.

### Convención de `audit_logs`

Toda emisión de factura genera un `audit_log` con el hash y el `aeat_status` final.

## 12. RGPD

### `data_subject_requests`

- `id`, `tenant_id`, `customer_id` (nullable), `email`, `request_type` (`access` | `rectification` | `erasure` | `portability` | `restriction`), `status` (`open` | `in_progress` | `fulfilled` | `denied`), `submitted_at`, `due_at` (1 mes desde submitted_at), `fulfilled_at`, `notes`, `handled_by_user_id`.

### `consents`

- `id`, `tenant_id`, `customer_id`, `purpose`, `granted` (boolean), `granted_at`, `revoked_at`, `evidence` (jsonb con IP, user-agent, texto exacto).

## 13. Super admin y soporte (Fase 8 + 9A)

### `super_admins`

Tabla global sin `tenant_id`. RLS deshabilitada (acceso solo via `PrismaAdminService`).

- `id`, `email` (UNIQUE), `password_hash` (argon2id), `name`, `role` (`superadmin` | `support`), `is_active`, `created_at`, `last_login_at`.
- **Fase 9A** añade: `two_factor_secret` (cifrado AES-256-GCM, nullable), `two_factor_pending_secret`, `two_factor_enabled` (boolean), `two_factor_enrolled_at`.

### `super_admin_sessions` (Fase 9A)

Sesiones refresh del super admin. Token opaco `<sessionId>.<secret>` con hash argon2id.

- `id`, `super_admin_id`, `refresh_token_hash`, `user_agent`, `ip_address`, `expires_at`, `rotated_at`, `revoked_at`, `revoked_reason`, `replaced_by_session_id`.

### `super_admin_recovery_codes` (Fase 9A)

10 códigos `XXXX-XXXX` hashed argon2id, single-use.

- `id`, `super_admin_id`, `code_hash`, `used_at`, `created_at`.

### `impersonation_logs`

- `id`, `super_admin_id`, `tenant_id`, `user_id` (a quien impersona), `started_at`, `expires_at` (TTL 1h), `reason`, `audit_metadata` (jsonb).

### `support_tickets`

State machine `open` → `in_progress` → `waiting_customer` ⇄ `in_progress` → `resolved` → `closed`.

- `id`, `tenant_id`, `subject`, `status`, `priority` (`low` | `medium` | `high` | `urgent`), `category`, `assigned_to_super_admin_id` (nullable), `created_by_user_id`, `created_at`, `resolved_at`, `closed_at`.

### `support_ticket_messages`

- `id`, `ticket_id`, `author_user_id` (nullable, si autor tenant), `author_super_admin_id` (nullable, si autor staff), `body`, `is_internal` (boolean, mensajes privados admin no visibles al tenant), `created_at`.

### `super_admin_audit_logs` (Fase 12A.3)

Tabla **global**, sin `tenant_id`, **sin RLS**. Acceso solo via `PrismaAdminService`. Registra cada acción crítica del super admin para trazabilidad y cumplimiento.

- `id`, `super_admin_id`, `action`, `target_tenant_id` (nullable), `target_user_id` (nullable), `metadata` (jsonb), `ip_address`, `user_agent`, `created_at`.
- `SuperAdminAuditService.record()` es **defensivo**: errores al insertar se loguean pero no rompen el flujo del super admin.
- Endpoint `GET /admin/audit-logs` (AdminGuard) con filtros `superAdminId`, `action`, `targetTenantId`, rango de fechas y cursor.
- Acciones registradas: `admin.login.success`, `admin.login.failed`, `admin.2fa.enabled`, `admin.2fa.disabled`, `admin.2fa.recovery_codes_regenerated`, `admin.2fa.challenge.success`, `admin.2fa.challenge.failed`, `admin.tenant.impersonate`, `admin.tenant.suspended`, `admin.tenant.reactivated`, `admin.tenant.trial_extended`.

## 14. SaaS billing (Fase 8)

### `subscription_plans` — campos adicionales (Fase 8)

- `stripe_price_id_monthly`, `stripe_price_id_yearly`, `stripe_product_id`, `is_active`, `features` (jsonb).

### `tenant_subscriptions` — campos adicionales (Fase 8)

- `stripe_customer_id`, `stripe_subscription_id`, `stripe_status` (espejo del status de Stripe), `current_period_start`, `current_period_end`, `cancel_at_period_end` (boolean), `canceled_at`.

## 15. Pendiente / post-MVP

Estado tras cerrar Fases 1-14 (MVP completo):

- **Cache `analytics_snapshots`**: si los 4 KPIs crecen en coste, materializar diariamente. Hoy se calculan on-demand sin tabla de snapshots.
- **AEAT `getStatus` por CSV**: hoy sólo cubrimos envío síncrono de alta + rectificativas. Consultar el estado posterior por CSV queda fuera del MVP.
- **WhatsAppProvider real (Meta WABA)**: la abstracción y stub existen desde Fase 5; falta integrar el proveedor en producción.
- **GoCardless (SEPA) y Redsys (TPV)**: el `PaymentGateway` ya tiene la abstracción; falta implementación de proveedores.
- **Bulk imports**: tablas/endpoints para carga masiva de customers, units y contratos.
- **`tenant_aeat_credentials_history`** ya no aplica: la propia tabla `tenant_aeat_credentials` actúa como histórico desde Fase 11A.2.
- **`security_events`** ya no aplica: implementada en Fase 11A.1.
- **Anulación/rectificación Veri\*Factu (F2, R1-R5)** ya no aplica: implementada en Fases 11A.4 y 13A.3 (diferencias + sustitución).
- **`api_keys`, `webhooks`, `webhook_deliveries`** ya no aplica: implementadas en Fase 14A.3.

## 16. Infra runtime

Banderas y modelos transversales que afectan al despliegue, no a una tabla concreta.

### Flag `ENABLE_WORKERS_IN_API` (Fase 14A.1)

Variable de entorno booleana (default `true`).

- `true` (dev y test): el proceso de `apps/api` registra los providers de las colas BullMQ y procesa jobs in-process. Cómodo para desarrollar sin levantar un proceso adicional.
- `false` (producción, `.env.prod`): `apps/api` sólo encola; los workers se ejecutan en `apps/worker` (proceso separado, mismos módulos pero sólo los `Processor`s de BullMQ). Permite escalar API ⇄ worker independientemente y aislar fallos.

### Endpoint OpenAPI gated (Fase 13A.2)

- `GET /api/docs` (Swagger UI) y `GET /api/docs-json` (schema) se montan siempre en dev/test.
- En producción se exponen sólo si `OPENAPI_ENABLED=true`. Cuando se habilita, debe quedar detrás de auth en Nginx Proxy Manager o accesible solo por VPN: el schema describe rutas internas no destinadas a público.

### Versionado URI (Fase 13A.2)

- `app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })`.
- TODAS las rutas viven bajo `/v1/...`. Rutas legacy responden **`308 Permanent Redirect`** preservando método HTTP y body.
- Excepciones marcadas `VERSION_NEUTRAL`: `/health`, `/webhooks/*`, `/public/widget/*`, `/api/docs`, `/api/docs-json`, `/api/csp-report`.
