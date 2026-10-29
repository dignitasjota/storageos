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

- id, name, slug (único), status (trial/active/suspended/cancelled), trial_ends_at, trial_ended_at (salida de la prueba, la pone el disparador `tenants_trial_ended_at`), billing_email, country, locale, currency, timezone, tax_id, created_at
- **Fase 12A.1**: `require_two_factor_for_managers BOOLEAN DEFAULT false`. Cuando `true`, todos los users con role `owner`/`manager` quedan obligados a tener 2FA activo; el `/auth/login` les devuelve un `enrolmentToken` corto en lugar de access/refresh hasta que se enrolen. Solo el `owner` puede modificar este flag (`PATCH /settings/tenant/security`).
- **Auto-charge (2026-06-11)**: `auto_charge_on_issue BOOLEAN DEFAULT false`. Cuando `true`, al emitir una factura se encola un cobro automático al método de pago predeterminado del cliente (cola BullMQ `payments`, listener de `domain.invoice_issued`). Solo el `owner` puede modificarlo (`PATCH /settings/tenant/billing`).
- **Primer pago con el mes siguiente (2026-10-28)**: `first_payment_next_month_from_day INT DEFAULT 20` (NULL = desactivado). Un contrato mensual que empieza a partir de ese día (y no el día 1) paga en su primera factura los días que quedan del mes más el mes siguiente completo; `billing_starts_on` pasa al mes después.
- **Recargo por mora (2026-06-22)**: `late_fee_enabled BOOLEAN DEFAULT false` (opt-in) + `late_fee_type TEXT DEFAULT 'percentage'` (percentage/fixed) + `late_fee_value DECIMAL(10,2) DEFAULT 5` + `late_fee_grace_days INT DEFAULT 7`. El dunning emite una factura separada de recargo a los N días de vencimiento. `GET/PATCH /settings/tenant/billing` (`billing:configure`). El enlace está en `invoices.late_fee_for_invoice_id` (FK self, único parcial → idempotencia).
- **Reviews/NPS (2026-06-22)**: `reviews_auto_request BOOLEAN DEFAULT false` + `review_request_delay_days INT DEFAULT 14`. Opt-in del cron `reviews.auto-request` que pide la valoración N días tras firmar. `GET/PATCH /settings/tenant/reviews` (`settings:read`/`settings:manage`).
- **Configuración (2026-10-28)**: `contact_phone`/`contact_email` (contacto del negocio, respaldo de los locales) y `custom_domain_ready_at` (el DNS del dominio propio ya apunta; se avisó al super admin).
- **Referidos (2026-06-22)**: `referral_enabled BOOLEAN DEFAULT false` + `referral_reward_type promotion_discount_type DEFAULT 'fixed'` + `referral_reward_value DECIMAL(10,2) DEFAULT 0`. Opt-in del programa de referidos; la recompensa (percentage/fixed) se materializa como una promoción de un solo uso al convertir. `GET/PATCH /settings/tenant/referrals`.

### `users`

Staff interno del tenant.

- `id`, `tenant_id`, `email` (único por tenant), `password_hash` (argon2id), `full_name`, `phone`, `role` (owner/manager/staff/readonly), `email_verified_at`, `two_factor_secret` (cifrado AES-256-GCM, ver ADR-015), `two_factor_pending_secret` (cifrado; setado durante el flujo de enrolment, se mueve a `two_factor_secret` al verificar), `two_factor_enabled`, `two_factor_enrolled_at`, `two_factor_last_step` (BIGINT nullable: último paso TOTP de 30 s aceptado en un login → anti-replay, 2026-09), `last_login_at`, `is_active`, `pending_email` + `email_change_token_hash` + `email_change_expires_at` (cambio de email pendiente de confirmar, 24 h, 2026-10-28).

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

### `coupons` y `coupon_redemptions` (2026-10-16)

Cupones: descuento sobre el **pago que se hace al contratar** (de 1 a 12 meses por adelantado), no sobre las renovaciones. Distintos de `promotions`, que descuentan todas las cuotas.

- `coupons` (RLS): id, tenant_id, code (único por tenant), name, discount_type (percentage/fixed/free_months; en free_months, `discount_value` = meses regalados), discount_value, min_months (meses mínimos pagados; en free_months debe superar a los regalados), min_amount (alquiler mínimo del periodo, sin IVA), unit_type_ids[] y facility_ids[] (vacío = todos), new_customers_only (sin ningún contrato firmado), once_per_customer (un uso por cliente, 2026-10-16), max_uses, used_count, valid_from, valid_until, is_active.
- `coupon_redemptions` (RLS): cada uso — coupon_id, customer_id, contract_id (único: un cupón por contrato), invoice_id, months, discount_amount, free_months.
- El cálculo es `quoteCoupon` (shared, en céntimos): % sobre todos los meses pagados, € fijo hasta el alquiler, meses gratis = los regalados × la cuota (se paga al menos un mes). La fianza y el seguro no se descuentan. El uso se reserva con `CouponsService.redeemInTx` (incremento condicionado a `used_count < max_uses`). Un cupón ya usado no se borra (409 `coupon_in_use`), se desactiva.

### `ad_metrics_daily` (2026-10-22)

- `ad_metrics_daily` (RLS): tenant_id, marketing_channel_id (CASCADE), platform (`google_ads` | `meta_ads`), campaign_id, date, cost, impressions, clicks, conversions (las de la plataforma; Google admite fracciones), updated_at. Única por canal y día. La rellena la misma sincronización que crea los gastos (`expenses.external_ref`), también los días sin gasto.

### Instagram y Facebook orgánico (2026-10-22)

- `tenant_social_accounts` (RLS, una por tenant): page_id, page_name, instagram_user_id/username (cuenta profesional vinculada), access_token_encrypted (token de la página, AES-GCM con AAD = tenant), status (`connected` | `error`), last_error, connected_at, last_synced_at. Conectar otra página borra lo descargado de la anterior; anonimizar el tenant borra todo.
- `social_daily_metrics` (RLS, única por tenant, red y día): network (`instagram` | `facebook`), followers, new_followers, reach, views, profile_views, website_clicks, engagements; null = Meta no la dio (una descarga posterior no borra un valor guardado). ~16 meses.
- `social_posts` (RLS, única por tenant, red y `external_id`): published_at, caption (500), media_type, permalink, thumbnail_url, likes, comments, shares, saves, reach, views. Publicaciones de los últimos 90 días, se actualizan en cada descarga.

### Resumen de marketing por correo (2026-10-22)

- `tenants.marketing_report_enabled` (por defecto **sí**) y `marketing_report_last_month` (`YYYY-MM` del último enviado, también de un mes sin actividad que no se envía, para no repetirlo).

### Google Analytics 4 (2026-10-22)

Datos de la propiedad de GA4 del tenant (Web Premium), descargados cada día por la cuenta de servicio de la plataforma. Agregados, sin datos personales.

- `tenant_ga4` (RLS, uno por tenant): property_id, status (`pending` | `connected` | `error`), last_error, connected_at, last_synced_at. Cambiar de propiedad borra lo descargado.
- `ga4_source_rows` (RLS): date, source, medium, campaign, device, sessions, engaged_sessions, page_views, key_events (único por tenant y esas dimensiones).
- `ga4_page_rows` (RLS): date, page_path, page_views, sessions (único por tenant, día y página).
- Al conectar se descargan 120 días; cada día, los 6 últimos (se sustituyen); se guardan unos 16 meses.

### `web_events` (2026-10-22)

Analítica propia de la web del tenant (todas las páginas: portada, locales, blog, landings, reserva). Sin IP ni datos personales.

- `web_events` (RLS): tenant_id (CASCADE), visitor_id (id aleatorio del navegador, el mismo de las landings), kind (`page_view` | `call_click` | `whatsapp_click` | `email_click` | `directions_click`), path (como lo ve el visitante: `/s/<slug>/precios` → `/precios`, `/book/<slug>` → `/reservar`), source/medium/campaign (origen recordado de la visita), device (`mobile` | `tablet` | `desktop`), created_at. Índices `(tenant_id, created_at)` y `(tenant_id, visitor_id, created_at)`.
- Una página vista cuenta una vez por visitante y página cada 30 min; un clic repetido en 10 s, una vez. Los robots no se guardan. Se borran a los `RETENTION_WEB_EVENTS_DAYS` (480).

### `promo_landings` (2026-10-16)

Landings de promoción de la web del tenant (extra Web Premium), en `/promo/<slug>`.

- `promo_landing_visits` (RLS): tenant_id, promo_landing_id (CASCADE), visitor_id (id aleatorio del navegador, sin datos personales), source, medium, campaign, created_at.
- `marketing_channels.promo_landing_id` (FK SET NULL): canal cuyo enlace corto / QR lleva a esa landing.

- `promo_landings` (RLS): id, tenant_id, name (interno), slug (único por tenant), is_active, starts_at/ends_at (opcionales; fuera de ellas no se sirve), headline, subheadline, offer_text, body, benefits[], conditions, cta_label, hero_image_key (bucket público, `<tenant>/promo/<id>/…`), coupon_id (FK coupons, SET NULL; opcional), facility_ids[] y unit_type_ids[] (vacío = todos), show_countdown, show_testimonials, show_faq, show_contact, seo_title, seo_description, indexable (por defecto false), created_at, updated_at.

## 4. Inquilinos finales

### `customers`

Inquilinos del tenant.

- id, tenant_id, customer_type (individual/business), first_name, last_name, company_name, document_type, document_number, email, phone, address, city, postal_code, country, emergency_contact_name, emergency_contact_phone, notes, tags (array), portal_access_enabled, portal_password_hash, portal_session_version (va en el JWT del portal como `sv`; incrementarla revoca todas sus sesiones), kyc_verified, kyc_verified_at, deleted_at
- **Referidos (2026-06-22)**: `referral_code TEXT` (índice único parcial por tenant, autogenerado 8 chars sin ambiguos al verlo en el portal). Es el código que el inquilino comparte para referir a otros.

### `customer_documents`

Archivos del cliente.

- id, customer_id, type (id_front/id_back/proof_of_address/other), file_url (MinIO), file_name, mime_type, file_size, uploaded_by_user_id, expires_at

## 5. Contratos y reservas

- **Reservas antes de la apertura (2026-10-28)**: `facilities.pre_opening BOOLEAN DEFAULT false` (local por abrir), `opening_date DATE NULL` (fecha prevista, opcional) y `pre_opening_max_months INT DEFAULT 6` (plazo desde la reserva; sin abrir, el cliente puede cancelar con devolución total). `contracts.pre_opening BOOLEAN` (reserva anticipada), `pre_opening_date_confirmed` (la `start_date` es la de apertura; si no, es la fecha límite, provisional), `pre_opening_deadline DATE`, `pre_opening_started_at` (día de apertura: desde aquí acceso, trastero ocupado y facturación recurrente desde `billing_starts_on` = apertura + 1 mes) y `pre_opening_reminder_sent_at`. Mientras no empieza, el trastero queda `reserved` y el contrato no cuenta en el MRR, la recurrente ni el alcance de los accesos (`STARTED_CONTRACT_WHERE`). `contracts.pre_opening_deadline_notified_at` (aviso de plazo vencido, una vez) y `coupons.pre_opening_only` (cupón solo para reservas antes de la apertura).

### `contracts`

Contratos de alquiler.

- id, tenant_id, customer_id, unit_id, contract_number (único por tenant), status (draft/active/ending/ended/cancelled), start_date, end_date (nullable si indefinido), billing_cycle (monthly/weekly/daily), price (la facturada), deposit_amount, deposit_status (none/held/returned/partially_returned), deposit_returned_amount, deposit_settled_at, deposit_retention_reason, first_payment_deadline (booking self-service), signed_at, signed_pdf_url, signature_provider, auto_renew, cancellation_notice_days, notes, deleted_at
- **Anti-doble-ocupación (2026-07-09)**: índice único parcial `contracts_one_active_per_unit` sobre `(unit_id) WHERE status IN ('active','ending') AND deleted_at IS NULL` — máximo un contrato vivo por trastero (los draft no cuentan). Complementa el `pg_advisory_xact_lock(tenant, unit_id)` en `sign()`/`changeUnit()`. Prisma no soporta índices parciales → SQL crudo en la migración.

### `contract_events`

Historial del contrato.

- id, contract_id, event_type (created/signed/price_changed/unit_changed/paused/resumed/ended), payload (jsonb), created_by_user_id, occurred_at

### `reservations`

Reservas previas a la firma.

- id, tenant_id, unit_id, customer_id (nullable), lead_id (nullable), status (pending/confirmed/expired/converted/cancelled), reserved_until, deposit_paid, deposit_amount, notes

## 6. Facturación y pagos

### `invoices`

- id, tenant_id, `customer_id` (**NULLABLE desde Fase 13A.3** para soportar F2 sin destinatario identificado), contract_id (nullable, p.ej. ventas sueltas), invoice_number (único por tenant, secuencial conforme a normativa), issue_date, due_date, status (draft/issued/sent/paid/overdue/cancelled/refunded), subtotal, tax_amount, total, currency, pdf_url, notes, deleted_at
- **`facility_id`** (2026-09-27, nullable, FK `ON DELETE SET NULL`): local al que se imputa una factura que no cuelga de un contrato ni de una venta de producto (hoy, el **pase nocturno**, que el inquilino compra para un local concreto). El cierre de caja por local la cuenta junto a las de contrato y venta.
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
- **Anti-doble-cobro (2026-07-08)**: índice único parcial `payments_one_live_gateway_charge` sobre `(invoice_id) WHERE gateway IN ('stripe','gocardless') AND status IN ('pending','processing','succeeded')` — máximo un cobro de pasarela vivo por factura (los `manual`/efectivo quedan fuera → parciales OK). Complementa el `pg_advisory_xact_lock(tenant, invoice_id)` en `chargeInvoice`. `amountPaid` se actualiza con `increment` atómico (no read-modify-write). Dedup de webhooks entrantes: `processed_stripe_events` y `processed_gocardless_events` (PK = event id).

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
- **contract_id / invoice_id** (2026-09-26, nullable, FK `ON DELETE SET NULL`): el recurso que originó el mensaje (recordatorios de pago y dunning → factura; firma, subidas de precio, valoraciones y alta de acceso → contrato; automatizaciones según su `entityType`). El historial `/communications` enlaza a inquilino, contrato, trastero y factura, y el API filtra por `?contractId=`/`?invoiceId=`. Los envíos anteriores quedan sin vínculo (no hay backfill).
- **is_marketing** (2026-10-01): envío comercial (campaña, win-back). Lleva pie y cabecera de baja y, al enviarse, se omite (`skipped`) si el destinatario se dio de baja. Relacionado: `customers.marketing_opt_out_at` (baja; un cliente recibe campañas mientras sea null) y `leads.marketing_consent_at`/`marketing_opt_out_at` (un lead solo con consentimiento y sin baja).

### `notifications` / `notification_reads`

`notifications.facility_id` (2026-10-02, nullable): local al que se refiere el aviso; null = toda la empresa. Un usuario con locales asignados (`user_facilities`) solo ve los de sus locales y los de empresa. El leído es **por usuario** en `notification_reads` (`notification_id`, `user_id`, `tenant_id`, `read_at`; PK notificación+usuario; RLS). `notifications.read_at` está obsoleto.

### `email_suppressions` (global, sin RLS, REVOKE al rol de la app)

Lista de supresión de correo. `email` (minúsculas), `tenant_id` (null = todos los tenants), `scope` (`all` = no se envía nada; `marketing` = solo se omiten las comunicaciones comerciales), `reason` (`hard_bounce`/`invalid_email`/`blocked`/`complaint`), `provider`, `detail`, `created_at`. Único `(email, tenant_id) NULLS NOT DISTINCT`. La alimentan los avisos de entrega de Brevo/Resend; un envío a una dirección con bloqueo total queda `skipped`.

### `message_templates`

- id, tenant_id, name, channel, subject, body, variables (jsonb), category, is_active

### `automation_rules`

- id, tenant_id, name, trigger_event, conditions (jsonb), actions (jsonb), is_active, last_run_at
- El enum `automation_trigger` añadió en 2026-06-22 los valores `review_request` y `review_submitted` (ciclo de valoración NPS).

### `reviews` (2026-06-22)

Valoraciones (NPS) del inquilino post-contratación. RLS por `tenant_id`.

- id, tenant_id, customer_id, contract_id (nullable), `token` (único, enlace público), token_expires_at, status (pending/submitted/expired), `nps_score` (0-10), `rating` (1-5), comment, channel (email/whatsapp/manual), source, requested_at, submitted_at, ip, user_agent
- Solicitud manual (`POST /reviews/request`) o cron `reviews.auto-request`. Pública por token: `GET/POST /public/reviews/:token`. Stats NPS en `GET /reviews/stats`. Permiso nuevo `reviews:read`/`reviews:write`.
- **Google Business Profile (2026-06-22)**: `tenants.google_review_url`; al enviar la valoración, si `nps_score >= 9` (promotor) y el tenant tiene el link, `submitByToken` lo devuelve y la página pública invita a dejar la reseña en Google.

### `referrals` (2026-06-22)

Programa de referidos. RLS por `tenant_id`.

- id, tenant_id, referrer_customer_id, referred_customer_id (**único** — un cliente se refiere una vez), status (pending/converted/cancelled), reward_promotion_id (FK a `promotions`, nullable), converted_at, created_at
- Se registra en el alta del referido (best-effort, en la transacción). El listener `domain.contract_signed` lo marca `converted` + genera la promoción-recompensa. Vista del portal `GET /portal/me/referrals`, panel `GET /referrals` (permiso `referrals:read`).

### `campaigns` (2026-06-22)

Campañas segmentadas por email. RLS por `tenant_id`.

- id, tenant_id, name, channel (email), subject, body_text, `segment` jsonb (audiencia clientes/leads + filtros), status (draft/sending/sent/cancelled), audience_count, sent_count, scheduled_for, sent_at, created_by_user_id
- Al enviar (`POST /campaigns/:id/send`) se resuelve la audiencia (con `withTenant`) y se encola una `communications` por destinatario (`source=campaign:<id>`, subject/body renderizados por destinatario). Permisos `communications:read`/`communications:send`.

### `ai_conversations` + `ai_messages` (2026-06-22)

Asistente IA para staff. RLS por `tenant_id`; conversaciones **por usuario** (`user_id`).

- **`ai_conversations`**: tenant_id, user_id (FK users), title.
- **`ai_messages`**: conversation_id, role (user/assistant), content, `tools_used` (jsonb, herramientas consultadas para transparencia).
- El asistente usa herramientas de lectura ejecutadas con el contexto del tenant **y del usuario** (solo las que su rol permite, filtradas por su `facilityScope`, 2026-09-28). Permiso `ai:use` (owner/manager/staff).
- **`ai_pending_actions`** (2026-09-28, RLS): acciones que el asistente IA propone y el usuario confirma o descarta. conversation_id (CASCADE), message_id (SET NULL), user_id (quien la propuso y la decide), `type` (create_task/payment_reminder/customer_message), `payload` jsonb validado, `summary`, `status` (proposed/confirmed/discarded/failed), `result` jsonb (`link` o `error`), created_at, resolved_at.

### `bank_statements` + `bank_statement_transactions` (2026-06-22)

Conciliación bancaria (Norma 43). RLS por `tenant_id`.

- **`bank_statements`** (extracto importado): filename, account_label, currency, start/end_date, initial/final_balance (céntimos), transaction_count.
- **`bank_statement_transactions`** (movimiento): operation/value_date, `amount` (céntimos **con signo**: + abono, − cargo), concept_common/own, reference1/2, document_number, description, status (pending/matched/ignored), matched_invoice_id (FK SET NULL).
- Flujo: `POST /bank-statements/import` parsea el fichero N43 → extracto + movimientos. El detalle sugiere facturas (issued/overdue con importe pendiente exacto) por cada abono pendiente; `match` marca la factura pagada (`markPaidManually`, bank_transfer). v1 solo abonos; cargos informativos. Permisos `invoices:manage` (import/match) / `payments:read` (lecturas).

### `sepa_settings` + `sepa_mandates` + `sepa_remittances` + `sepa_remittance_items` (2026-06-22)

Remesas SEPA (adeudos directos, fichero pain.008). RLS por `tenant_id`.

- **`sepa_settings`** (acreedor, única por tenant): creditor_name, creditor_id (identificador del acreedor SEPA), creditor_iban_encrypted (AES-GCM), creditor_bic, enabled, `prenotice_days` (días de preaviso de los cargos, 14 por defecto = reglamento SEPA; 2026-10-01).
- **`sepa_mandates`** (por cliente): reference (única autogenerada), iban_encrypted + iban_last4, bic, signed_at, sequence_type (FRST→RCUR), status (active/cancelled). Índice parcial **único mandato activo por cliente**.
- **`sepa_remittances`** (lote): message_id, collection_date, status (generated/confirmed/cancelled), item_count, total_amount (céntimos), xml.
- **`sepa_remittance_items`** (por factura): invoice_id (único **parcial**: una sola remesa viva —`status` pending/collected— por factura; tras una devolución o una remesa cancelada puede presentarse otra vez), mandate_id (FK), amount (céntimos), sequence_type, end_to_end_id (con sufijo por remesa), `status` (pending · collected · failed · returned · cancelled, migración `20261005120000`) + `failure_reason`.
- Flujo: config acreedor + mandatos → `POST /sepa/remittances` genera el XML pain.008 → descargar → `POST /sepa/remittances/:id/confirm` marca las facturas pagadas (manual, methodType `sepa_debit`) + mandatos FRST→RCUR. Permisos `invoices:manage` (remesas) / `payments:charge` (mandatos) / `billing:configure` (settings).

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

### `sessions` (refresh del panel)

- `installed_app` (boolean): sesión abierta desde la app instalada en el móvil; caduca a los `JWT_REFRESH_APP_TTL_SECONDS` (90 días) en vez de 7 y lo heredan las sesiones que salen de ella al renovar. `revoked_reason` `lost_response`: sustituida porque la respuesta de la renovación no llegó al navegador.

### `platform_redsys_settings` / `platform_redsys_orders` (globales)

- TPV Redsys de la plataforma para cobrar la suscripción: `merchant_code`, `terminal`, `secret_key_encrypted` (AAD `platform-redsys-settings`), `environment`, `enabled`, `bizum_enabled`, `card_on_file_enabled`. Cada pago es una orden (`order` = número de pedido del TPV; `tenant_id`, `amount_cents`, `pay_method`, `status` pending/paid/failed/replaced, `ds_response`, `payment_id` del pago de la suscripción). REVOKE para `storageos_app`.

### `user_passkeys` (bloqueo de la app del móvil)

- Llave de acceso (Face ID / huella) de un usuario del panel: `credential_id` (único), `public_key`, `counter`, `transports`, `label`, `last_used_at`. RLS por tenant. En `users`: `app_pin_hash` (argon2id, PIN de respaldo de 4-6 cifras), `app_pin_failed_attempts` (5 seguidos cierran todas las sesiones) y `webauthn_challenge`/`webauthn_challenge_expires_at` (reto de un solo uso, 5 min).

### `invoice_series`

- `id`, `tenant_id`, `code` (único por tenant), `name`, `prefix`, `year_scope` (boolean), `next_number`, `numbering_year` (año de la numeración: en una serie por año, el primer número de un año nuevo vuelve a 1; migración `20261111100000_invoice_numbering_year`), `facility_id` (nullable), `is_active`.
- Índice único `invoices_series_sequence_unique` sobre `(tenant_id, series_id, EXTRACT(YEAR FROM issue_date), sequence_number) WHERE sequence_number > 0`: el número se repite en años distintos, nunca dentro del año.

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
- **Fase 9A** añade: `two_factor_secret` (cifrado AES-256-GCM, nullable), `two_factor_pending_secret`, `two_factor_enabled` (boolean), `two_factor_enrolled_at`. **2026-09 (#526):** `two_factor_last_step` (anti-replay TOTP, igual que en `users`).

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

### `billing_mode` + `platform_sepa_*` — cobro SaaS por SEPA directo (2026-09-15/17, PRs #503-#505)

Tercer modo de cobro de la suscripción (junto a Stripe y manual), para domiciliar
la cuota directamente contra la propia cuenta bancaria de la plataforma (p.ej.
BBVA) sin la comisión de Stripe. Espejo, a nivel plataforma, del `SepaModule`
que cada tenant ya usa para domiciliar a sus inquilinos (§8) — mismo patrón
pain.008, pero sin API de banco: fichero que se sube a mano.

- **`tenant_subscriptions.billing_mode`** (`'manual'|'stripe'|'sepa'`, default
  `'manual'`, backfill desde `stripe_subscription_id IS NOT NULL`). Fuente de
  verdad explícita — antes se inferia solo de `stripe_subscription_id`.
  `'stripe'` solo se alcanza vía el webhook `customer.subscription.updated`
  (no es un destino directo de `setBillingMode`, que solo acepta
  `'manual'|'sepa'`).
- **`platform_sepa_settings`** (singleton, sin `tenant_id`, sin RLS — mismo
  patrón `findFirst() ?? create()` que `platform_dunning_settings`):
  creditor_name, creditor_id, creditor_iban_encrypted (AES-GCM, AAD fijo
  `'platform-sepa-settings'`), creditor_bic, enabled. Un único acreedor para
  **todos** los tenants en modo `'sepa'` — cambiar de banco es reapuntar esta
  fila, sin migración por tenant.
- **`platform_sepa_mandates`** (deudor = el TENANT, no un customer; sin RLS,
  scopeada por `tenant_id` explícito vía `PrismaAdminService`, como
  `tenant_subscription_payments`): reference (`MND-…`), iban_encrypted (AAD =
  `tenant_id`) + iban_last4, bic, signed_at, sequence_type (FRST→RCUR),
  status (active/cancelled). Autoservicio: solo el propio tenant lo crea; el
  admin solo ve/cancela (soporte). Un mandato activo por tenant por
  soft-cancel-and-replace en código.
- **`platform_sepa_remittances`** + **`platform_sepa_remittance_items`**
  (sin RLS, tablas de plataforma): remesa = lote (name, message_id,
  collection_date, status generated/confirmed/cancelled, item_count,
  total_amount céntimos, xml); item = **tenant + periodo** (no factura,
  a diferencia de `sepa_remittance_items`) — `mandate_id`, amount céntimos,
  sequence_type, end_to_end_id, **`period_covered` @db.Date + índice único
  parcial `platform_sepa_remittance_items_live_period` (tenant_id,
  period_covered) WHERE item_status IN (pending, collected)** (la clave
  anti-doble-cobro, ya que no hay invoice al que colgar el unique; solo en SQL
  desde la migración `20261030100000_platform_sepa_retry_bounced`: un adeudo
  devuelto se vuelve a domiciliar por el mismo periodo con EndToEndId
  `…-R<n>`), `item_status` (pending/collected/bounced), bounced_at,
  bounce_reason. Marcar un adeudo como devuelto retira de la suscripción el
  periodo que pagaba (y la pasa a `past_due` si ya venció).
- **Importe**: plan + add-ons NO suspendidos y NO ya cobrados por su propio
  subscription item de Stripe (evita el doble cobro de un add-on en
  `billing_mode='stripe'` individual).
- **Flujo**: `POST /admin/platform-sepa/remittances/preview` → `POST
.../remittances` genera el XML con `buildPain008` (reutilizada tal cual del
  módulo tenant-facing) → descargar y subir al banco → `POST
.../remittances/:id/confirm` reutiliza `BillingSaasService.
recordManualPayment` (provider `'sepa'`, mismo candado/dedup/extensión de
  periodo que el pago manual) por item + rota FRST→RCUR. Si el banco
  devuelve un adeudo ya cobrado: `POST .../remittance-items/:id/bounce`
  marca el item `bounced` y fuerza `status='past_due'` en la suscripción
  **explícitamente** (único punto sin webhook — el periodo ya se adelantó al
  confirmar, así que el cron de morosos manuales no lo detectaría hasta el
  siguiente vencimiento) — `PlatformDunningService.run()` recoge el
  `past_due` sin ningún cambio en ese servicio (ya es agnóstico del origen
  del impago).
- Endpoints admin-only (`AdminGuard`); mandato con endpoints self-service del
  tenant en `/settings/saas-billing/sepa-mandate`.

### Contabilidad: Holded y asesoría (2026-10-01, #573–#575)

- `holded_settings.invoice_series_id` / `credit_note_series_id` (TEXT): series de Holded marcadas «No enviar a Verifactu» donde se copian las facturas y las rectificativas del tenant.
- `payments.holded_synced_at` (TIMESTAMPTZ): cobro ya copiado a Holded. `invoices.holded_cancelled_at` (TIMESTAMPTZ): anulación ya copiada.
- Copia sin duplicados (migración `20261005100000_holded_sync_claims`): `invoices.holded_sync_state` (TEXT: null | `creating` reservada y enviando | `approving` creada en Holded, falta aprobarla) + `invoices.holded_sync_started_at`; `payments.holded_sync_started_at` (reserva del cobro) + `payments.holded_reviewed_at` (cobro ya copiado y luego devuelto/reembolsado, revisado a mano en Holded). Una reserva que se queda porque Holded no respondió no se reintenta sola: sale «para revisar» pasados 5 minutos.
- `tenants.billing_legal_name` / `billing_address` / `billing_city` / `billing_postal_code` (TEXT): datos fiscales del tenant como destinatario de sus facturas de suscripción (junto a `tax_id` y `country`). La factura (`platform_invoices.tenant_name` / `tenant_address`) guarda una copia al emitirse.
- `platform_billing_settings.own_tenant_id` (UUID, FK `tenants` SET NULL): negocio propio de la SL emisora, incluido en la exportación para la asesoría.
- `platform_invoices.invoice_type` (TEXT, `F1` por defecto; `R1`/`R4` en rectificativas), `rectifies_invoice_id` (UUID, FK a sí misma, RESTRICT), `rectification_reason`, `correction_method` (`substitution`|`differences`). Las rectificativas van en la serie `R<año>`; la original pasa a `status` `rectified` (sustituida) o `cancelled` (abonada por completo).
- `platform_billing_settings.holded_enabled` / `holded_api_key_encrypted` (AES-GCM) / `holded_invoice_series_id` / `holded_last_sync_at` / `holded_last_error` y `platform_invoices.holded_document_id`: copia en Holded de las facturas de suscripción (desactivada por defecto).

## 14.9. Seguridad — columnas y permisos (auditoría 4, 2026-09-25)

- `customers.portal_session_version` (INT, default 0, #521): versión de sesión
  del portal del inquilino; viaja en el JWT del portal como `sv` y se compara en
  cada request. Se incrementa al restablecer o desactivar la contraseña del
  portal y con «Cerrar sesiones del portal» (staff) → invalida todas las
  sesiones vivas.
- `customer_messages.sender_verified` (BOOLEAN, default true, #523): `false`
  solo en emails entrantes sin DMARC `pass` (el `From` podría estar
  falsificado); el chat del staff lo marca «remitente no verificado».
  `customer_messages` es el hilo inquilino↔staff (un hilo por cliente; `channel`
  portal/whatsapp/email, `sender_type` customer/staff).
- `users.two_factor_last_step` / `super_admins.two_factor_last_step` (BIGINT
  nullable, #526): anti-replay TOTP.
- **Permisos del rol `storageos_app`** (#527): sin acceso (`REVOKE ALL`) a las
  26 tablas globales de plataforma sin RLS (`super_admins*`, `security_events`,
  `impersonation_logs`, `platform_*`, `processed_*_events`, `cron_runs`,
  `mrr_snapshots`, `tenant_followups`, `tenant_lifecycle_emails`). Se conservan
  `subscription_plans` y `subscription_addons` (los leen consultas del tenant).
  ⚠️ Los default privileges conceden CRUD a `storageos_app` en cada tabla nueva:
  **una tabla global nueva debe incluir su propio `REVOKE` (o RLS) en la
  migración.**
- `customer_message_reads` (RLS, PK `customer_id`+`user_id`, `last_read_at`): hasta cuándo ha leído cada usuario del equipo la conversación con un inquilino (bandeja «Mensajes» y badges por usuario). Sin fila, cuenta desde el alta del usuario. `customer_messages.read_at` sigue siendo el leído del equipo (avisos sin repetir) y el del inquilino en el portal.
- `tenant_platform_messages` (RLS): mensajes de TrasterOS al tenant (`kind` direct/announcement/retention, asunto, cuerpo, `ticket_id` del correo directo, `super_admin_id`). Los lee el tenant en Soporte.
- Adjuntos de mensajes: `support_ticket_messages` y `customer_messages` ganan `attachment_key`, `attachment_mime`, `attachment_name` (imagen o PDF en `uploads`).
- Mandato SEPA firmado: `sepa_settings.creditor_address/_postal_code/_city/_country`; `sepa_mandates.signature_status` (`pending` | `signed` | `external`, los que ya existían quedan `external`), `signing_token_hash/_expires_at`, datos del deudor (`debtor_*`), firma (`signer_name`, `signature_method`, `signature_image`, `typed_signature`) y constancia (`document_text`, `document_hash`, `signed_ip`, `signed_user_agent`, `signed_at_ts`).
- Mandato SEPA de la plataforma firmado: `platform_sepa_settings.creditor_address/_postal_code/_city/_country` y `prenotice_days` (5); `platform_sepa_mandates.signature_status` (`signed` | `external`, los existentes `external`), datos del deudor, firma (`signer_name`, `signer_user_id`, `signature_*`, `typed_signature`) y constancia (`document_text`, `document_hash`, `signed_ip`, `signed_user_agent`, `signed_at_ts`); `platform_sepa_remittance_items.prenotice_sent_at/_recipients`.
- Caducidad del mandato: `sepa_mandates.last_collected_at` y `platform_sepa_mandates.last_collected_at` (DATE, último adeudo presentado; estado `expired` a los 36 meses sin cobros).
- Revisión del mandato (migración `20261110160000_sepa_mandate_review`): `sepa_mandates.prenotice_days` y `platform_sepa_mandates.prenotice_days` (preaviso pactado en ese mandato; relleno con el del texto firmado o, si no, el del ajuste del acreedor), `sepa_mandates.signing_link_sent_to` (email del enlace de firma) y `platform_sepa_remittance_items.prenotice_status` (`sent` | `failed` | `no_email`); `item_status` admite `cancelled`.

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

### Proveedor de correo de la plataforma (2026-09-30)

- **`platform_email_settings`** (singleton global, sin RLS, `REVOKE` al rol de la
  app): `provider` (`'brevo'|'resend'|NULL`; NULL = variable `EMAIL_PROVIDER`) +
  `fallback_enabled` (si el principal falla se reintenta con el otro). Las claves
  siguen en variables de entorno; un proveedor sin clave se salta. El envío lo
  decide `RoutingEmailProvider` (token `EMAIL_PROVIDER`), con el ajuste cacheado
  30 s. `communications.provider` guarda el proveedor que entregó realmente.
- **`tenants.staff_email_settings`** (jsonb, default `{}`): avisos por email al equipo que el tenant ha apagado; ausente = activado.
- **`tenants.customer_email_settings`** (jsonb, default `{}`): correos automáticos al inquilino que el tenant ha apagado (`{"invoice_issued": false}`); una clave ausente = activado.
- **`platform_email_settings.tipo_labels`** (jsonb, default `{}`): texto de la variable `{tipo}` del nombre del remitente por correo concreto (solo los cambiados).
- **`platform_email_settings.senders`** (jsonb, default `{}`): remitentes de la plataforma `{ default?, account?, subscription?, billing?, admin_messages?, staff_notices? }`, cada uno `{ name?, email?, replyTo? }`; vacío = variables `EMAIL_FROM_*`.
- **`tenant_email_domains`** (RLS, 1 por tenant, `domain` único global porque
  todos viven en la cuenta Brevo de la plataforma): `from_local_part`,
  `from_name?`, `reply_to?`, `status` (`pending|verified|failed`), `dns_records`
  (jsonb normalizado de Brevo), `verified_at`, `last_checked_at`, `last_error`.
  Se usa solo si está `verified` **y** el plan incluye `custom_domain`.
  `ownership_token` + `ownership_verified_at`: prueba de propiedad por tenant
  (TXT `_trasteros.<dominio>` = `trasteros-verification=<token>`); `verified`
  exige Brevo autenticado **y** propiedad probada. Borrar la fila no borra el
  dominio de Brevo.

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

- `users.email_notice_prefs` (jsonb, 2026-10-04): avisos por correo al equipo que el usuario cambió (`{tipo: bool}`); lo que falta toma el defecto de su rol (propietario/gestor: sí; resto: no).
- `platform_email_logs` (global, REVOKE, 2026-10-04): correos que manda la plataforma (no los de un tenant a sus inquilinos). `recipient`, `subject`, `body_text` (null en los de cuenta), `kind`/`category`, `status` (sent/delivered/bounced/failed/suppressed), `provider`, `provider_message_id`, `error_message`, `delivered_at`, `tenant_id` (FK SET NULL, deducido del destinatario). Retención 180 días.
- `sepa_remittance_items.prenotice_*` (2026-10-04): constancia del preaviso SEPA de cada adeudo — `prenotice_status` (null = pendiente, `sent`, `disabled`, `no_email`, `failed`), `prenotice_at`, `prenotice_recipient`, `prenotice_subject`, `prenotice_text`, `prenotice_communication_id` (FK SET NULL). Los preavisos en `communications` se conservan `RETENTION_SEPA_PRENOTICE_DAYS` (430) días.
- `invoice_status` += `rectified` (2026-10-05, migración `20261005140000_invoice_status_rectified`): factura emitida anulada con una rectificativa de abono por el total. Cuenta en los informes fiscales y en la cadena Veri\*Factu; no se cobra. `cancelled` queda para borradores.
- `invoices.chain_seq` / `previous_invoice_id` / `aeat_record_timestamp` (2026-10-05, migración `20261005160000_verifactu_chain`): cadena Veri\*Factu por emisor (posición única por tenant, registro anterior) y la FechaHoraHusoGenRegistro usada en la huella. `hash`/`previous_hash` en mayúsculas.
- `invoices.kind` (`invoice` | `deposit_receipt`) + `bundled_with_invoice_id` (2026-10-05, migración `20261005180000_deposit_receipts`): justificante de fianza (no es factura: sin IVA, sin Veri\*Factu, fuera de informes fiscales, Holded e ingresos) y la factura con la que se cobra en un solo pago.
- `payments.customer_id` opcional (2026-10-05, migración `20261005200000_payment_customer_optional`): el cobro de una factura simplificada (F2) sin cliente crea su pago.
- `platform_invoices.holded_sync_state`/`holded_sync_started_at`/`holded_credit_note_id`/`holded_payment_started_at`/`holded_payment_synced_at` + `platform_billing_settings.holded_credit_note_series_id` (2026-10-06, migración `20261006100000_platform_holded_claims`): copia en Holded de las facturas de suscripción sin duplicados y con rectificativas.
- `invoice_series.is_rectification` + valor `credit_note` en `payment_method_type` (2026-10-06, migración `20261006120000_rectification_series_credit_compensation`): serie propia de rectificativas (la crea la app) y pago de compensación de un abono (no es dinero cobrado).

- `tenants.invoicing_mode`/`invoicing_mode_pending`/`invoicing_mode_pending_from`, `holded_settings.issuing_invoice_series_id`/`issuing_credit_note_series_id`, `invoices.issued_by` (2026-10-06, migración `20261006140000_tenant_invoicing_mode`): dónde se emiten las facturas del tenant (app con Veri\*Factu u Holded) con cambio programado al 1 de enero.

- `platform_billing_settings.prices_include_vat`/`stripe_tax_rate_id`/`stripe_tax_rate_percent` (2026-10-06, migración `20261006160000_platform_prices_vat`): precios de la plataforma con IVA incluido o +IVA.

- `platform_invoices.invoice_id`, `invoices.platform_payment_id`, `customers.platform_tenant_id`, `tenant_subscription_payments.invoicing_claimed_at` (2026-10-06, migración `20261006180000_platform_invoices_own_tenant`): facturas de suscripción emitidas como facturas del negocio propio; el único `(series, number)` de `platform_invoices` pasa a parcial `WHERE series <> 'own'`.

- `tenant_subscription_payments.refunded_amount`/`refunded_at`/`disputed_at`/`dispute_reason`, `platform_sepa_remittance_items.payment_id` (2026-10-06, migración `20261006200000_saas_payment_reversals`): devoluciones de los cobros de suscripción y su abono.

- `customers.deposit_exempt` y `contracts.deposit_payment_method` (`online`|`cash`) (2026-10-04, migración `20261007100000_deposit_exempt_cash`): inquilinos sin fianza y fianza cobrada en efectivo en el local (justificante sin enlazar a la 1ª factura y sin vencimiento).

- `communications.secrets_encrypted` (2026-10-03, migración `20261003100000_communication_secrets`): valores secretos de un envío (el PIN de acceso) cifrados AES-GCM con AAD = tenant; en `variables` y en el cuerpo guardado quedan tapados (`••••`) y solo se ponen al enviar.
- `dunning_action_type` += `email_reminder_final` + plantilla `invoice_overdue_final_email` (2026-10-03, migración `20261003160000_dunning_reminders`): segundo recordatorio de impago (antes nunca se programaba por el índice único por tipo).
- `tenants.transfer_iban` (2026-10-04, migración `20261004100000_tenant_transfer_iban`): IBAN para transferencias que sale en el correo de la factura cuando se paga a mano.
- `tenants.offline_transfer_enabled` / `offline_cash_enabled` / `offline_sepa_enabled` y `contracts.offline_payment_method` (`bank_transfer`|`cash`|`sepa_debit`) / `offline_payment_chosen_at` (2026-10-28, migración `20261121100000_offline_payment_options`): formas de pago sin pasarela que el inquilino puede elegir (cada una la activa el tenant) y la que eligió para la primera factura de su reserva.
- `contracts.booking_reminder_sent_at` (2026-10-04, migración `20261004120000_contract_booking_reminder`): recordatorio único de una reserva online enviada sin firmar o sin pagar.

## 17. Novedades de octubre de 2026 (migraciones `20261007100000` → `20261031120000`)

> Las tablas **globales** (sin `tenant_id` o leídas solo por el super admin) llevan `REVOKE ALL … FROM storageos_app`; las de tenant, RLS `tenant_isolation`.

### Fianza (`20261007100000_deposit_exempt_cash`)

- `customers.deposit_exempt` (bool): sus contratos nuevos salen con fianza 0.
- `contracts.deposit_payment_method` (`online`|`cash`): en efectivo el justificante sale sin enlazar a la 1ª factura y la fianza queda en «Hoy».

### Motor de precios (`20261008100000` – `20261009100000`)

- `competitor_facilities`: `phone`, `website`, `address`, `contact_method` (phone/web/visit/email/whatsapp/other) + `contact_notes`, `distance_km`, `inventory_complete` + `inventory_completed_at`, `known_total_units`, `current_promotion`, `promo_free_months`/`promo_discount_pct`/`promo_discount_months`, `deposit_amount`, `setup_fee`, `mandatory_insurance_monthly`, características y `last_reviewed_at`.
- `competitor_units.external_ref`.
- **`competitor_unit_observations`** (RLS): cada comprobación de un trastero de la competencia (precio y estado). Alimenta el histórico, la tendencia del mercado y el ritmo de alquiler.
- **`unit_price_history`** (RLS): cambios de precio de mis trasteros (`source` manual/suggestion). Alimenta la espera mínima entre cambios y el efecto de los cambios.
- `tenants.daily_summary_last_date` (DATE): último día, en la hora del tenant, en que salió el resumen del día por correo.
- `tenants.pricing_target_occupancy` (88), `pricing_max_step_pct` (8), `pricing_min_days_between_changes` (30); `facilities.pricing_positioning_pct` y `facilities.features` (text[]); `unit_types.min_price_monthly`/`max_price_monthly`.
- `leads.lost_reason_code` (too_expensive, found_other, not_needed, no_availability, location, no_response, other).

### Panel de administración (`20261010100000` – `20261010160000`)

- **`cron_heartbeats`** (global): `name`, `process` (api/worker), `expression`, `last_run_at`, `next_run_at`. Atrasada = la prevista pasó hace más de 15 min.
- `tenant_aeat_credentials.expiry_notified_days`: último hito avisado de caducidad (30/15/7/0).
- **`ai_usage_events`** (global): tokens de entrada/salida por llamada al modelo (`feature`, `model`, `user_id`).
- **`tenant_storage_usage`** (global): bytes y ficheros por tenant (`by_bucket` jsonb), medido a diario.
- **`product_updates`** (global): título, cuerpo Markdown, `category` new/improvement/fix, `feature` de pago opcional, `link` interno, `published_at` (null = borrador). `users.product_updates_seen_at`.
- `support_tickets.first_response_at` + **`support_canned_responses`** (global).

### Facturación, cobros y migración (`20261011100000` – `20261011180000`, `20261011280000`)

- `invoice_items.tax_category`: `S1` (con IVA), `E1`–`E6` (exenta, por artículo de la Ley del IVA), `N1`/`N2` (no sujeta). Las líneas al 0 % anteriores pasan a `N1`.
- `contracts.billing_starts_on`: primer día que factura la app (contratos activados tras importar).
- `tenant_aeat_credentials.cert_organization_nif` (NIF de la entidad del certificado) y `representative_name`.
- `payments.returned_at`: fecha en que se devolvió un cobro ya cobrado (devolución bancaria, contracargo, fallo tardío).
- `tenants.bank_auto_reconcile`; `bank_statement_transactions.auto_matched` + `matched_payment_id` (FK SET NULL) para deshacer.
- IRPF: valor `withholding` en el enum `payment_method_type` (pago no monetario), `contracts.irpf_retention_pct`, `invoices.withholding_pct`/`withholding_amount`.

### Viviendas (`20261011200000` – `20261011260000`)

- `unit_types.property_kind` (`storage`|`housing`): el alquiler de una vivienda se factura exento (E1).
- `tenants.housing_contract_clauses`: plantilla de contrato de vivienda.
- `contracts.deposit_registry_body`, `deposit_registered_at`, `deposit_registry_reference`, `deposit_registry_receipt_key` (bucket privado), `deposit_registry_recovered_at`.
- `tenants.anniversary_update_enabled`/`anniversary_update_pct`/`anniversary_update_scope` (housing|all); `contracts.last_anniversary_update_on`.

### Propietarios — plan Administrador (`20261012100000` – `20261012160000`)

- **`owners`** (RLS): razón social, NIF (único por tenant), dirección, email, teléfono, IBAN cifrado AES-GCM + últimos 4, honorarios (`fee_type` percentage|fixed + `fee_value`), notas, activo.
- `facilities.owner_id` y `contracts.owner_id` (FK SET NULL): el contrato copia el propietario del local al crearse.
- `invoices.owner_id` e `invoice_series.owner_id` (FK RESTRICT): el propietario es el emisor. La cadena Veri\*Factu es por emisor: índice único `invoices_tenant_chain_seq` sobre `(tenant_id, COALESCE(owner_id, 0…), chain_seq)`.
- `tenant_aeat_credentials.owner_id`: certificado propio del propietario (si no tiene, se usa el del tenant como representante).
- **`owner_statements`** (RLS): foto de cada liquidación guardada o enviada (cobrado, devuelto, honorarios + IVA, gastos, retención, neto, pendiente, `detail` jsonb, `sent_at`/`sent_to`); única por propietario y periodo.

### Web de TrasterOS (`20261013100000` – `20261014100000`)

- **`platform_founder_offer`** (global, un registro): `enabled` (false), `title`, `text`, `setup_strike`, `setup_text`.
- **`platform_website`** (global, un registro): `logo_key` (bucket público, `platform/logo/…`), formulario de contacto (`contact_enabled`, `contact_email`, `contact_title`, `contact_subtitle`, `contact_show_phone`/`contact_require_phone`/`contact_show_company`/`contact_show_units`/`contact_show_profile`) y `footer` jsonb (null = `DEFAULT_PLATFORM_FOOTER` de shared).
- **`platform_contact_messages`** (global): mensajes del formulario (`email_sent`, `handled_at`, `ip_address`).
- `platform_website.seo` (jsonb; null = valores por defecto) y `platform_website.og_image_key` (imagen para redes, `platform/og/…`) — migración `20261015100000_platform_seo`.

### Web del tenant (`20261016100000`)

- `tenants.web_seo` (jsonb): título y descripción para Google de la portada, `/precios` y `/contacto` (`homeTitle`/`pricesTitle`/`contactTitle` ≤70, `*Description` ≤200; vacío = el generado). Las plantillas «Trstrom» y «Cabe», la reserva en `/reservar/<centro>` y las direcciones `/precios` y `/contacto` no tienen migración (valores de `tenants.web_template` y rutas del dominio propio).
- `tenants.web_favicon_key` (texto, null = el de TrasterOS): favicon de la web pública del tenant en el bucket público.

### WhatsApp Business (`20261017100000` – `20261022100000`)

Extra `whatsapp_business` (solo de venta aparte). Tablas de tenant con RLS; la global, con REVOKE.

- **`tenant_whatsapp_settings`** (una por tenant): `phone_number_id` (único global: así se reparte el webhook), `waba_id`, `display_phone`, `verified_name`, `access_token_encrypted` (AES-GCM), `enabled`, `web_button_enabled`; asistente: `assistant_enabled`, `assistant_instructions`, `ai_mode` (`platform`|`own`, lo decide el super admin), `ai_monthly_limit`, clave propia (`own_ai_provider`/`own_ai_model`/`own_ai_base_url`/`own_ai_api_key_encrypted`), `ai_limit_notified_month`; reservas y plantillas: `assistant_bookings_enabled`, `reminder_template_name`/`reminder_template_language`; `privacy_url` (política que enlaza el aviso de IA).
- **`whatsapp_conversations`** (una por tenant y número, `wa_id`): `contact_name`, `customer_id`/`lead_id`, `last_inbound_at` (ventana de 24 h), `last_message_at`/`last_message_preview`, `unread_count`, `assistant_enabled` (se pausa al responder el equipo o al pasar a una persona), `contract_id` (reserva preparada por el asistente) + `booking_reminder_sent_at`, `language` (idioma del contacto).
- **`whatsapp_messages`**: `direction` in/out, `sender` contact/staff/assistant, `body`, `wa_message_id` (único: deduplica y casa los avisos de estado), `status`, `error`, `sent_by_user_id`, `ai_key_source` (platform/own: el límite mensual se cuenta con estas filas, por eso al anonimizar se vacían y no se borran); archivos: `media_type` (image/audio/video/document/sticker), `media_key` (bucket privado `uploads`, `<tenant>/whatsapp/<conversación>/…`), `media_mime`, `media_filename`, `media_size`.
- **`platform_ai_settings`** (global, un registro, REVOKE): asistente IA del panel — clave de Anthropic cifrada (AAD `platform-ai-settings`; null = `ANTHROPIC_API_KEY`), modelo (null = `AI_MODEL`), `monthly_query_limit` (300) `daily_user_limit` (50) y `portal_daily_limit` (20, preguntas al día por inquilino en el área de clientes). Relacionado: `ai_usage_events.counts_as_query` (la reserva de cada pregunta, creada antes de llamar al modelo; las llamadas guardan solo los tokens) y `ai_usage_events.customer_id` (inquilino del chatbot), `subscription_addons.grants_ai_queries`, `tenants.ai_monthly_limit` (límite propio) y `tenants.ai_limit_notified` (último aviso, `AAAA-MM:80|100`). `tenants.ai_mode` (`platform`|`own`), `ai_own_api_key_encrypted` (AES-GCM, AAD = tenant) y `ai_own_model`; `ai_usage_events.own_key` (consulta con la clave del tenant: no cuenta para el límite ni para el coste).
- **`platform_whatsapp_ai_settings`** (global, un registro, REVOKE): IA de WhatsApp de la plataforma — proveedor (anthropic/openai/minimax/openai_compatible), modelo, URL, clave cifrada (AAD `platform-whatsapp-ai`), `monthly_reply_limit` (300), `enabled`.
- **RGPD**: anonimizar a un inquilino o un tenant vacía sus mensajes, quita el número y borra sus archivos; la limpieza diaria borra las conversaciones sin movimiento en `RETENTION_WHATSAPP_DAYS` (365) y sus archivos.
- **App de Meta propia** (`20261023100000_whatsapp_own_app`): `tenant_whatsapp_settings.app_secret_encrypted`, `webhook_verify_token_encrypted` y `webhook_verify_token_hash` (único) para números conectados con la app de Meta del propio tenant.

### Cobro con tarjeta (`20261024100000` – `20261024140000`)

- **`platform_payment_settings`** (global, un registro, REVOKE): `application_fee_pct` (comisión de la plataforma sobre los cobros con tarjeta por Stripe Connect, 2 % por defecto).
- **`tenant_stripe_accounts`** (RLS, una por tenant): `stripe_account_id` (único), `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements_due`, `disabled_reason`.
- `tenants.card_provider` (`redsys`|`stripe`, null = Redsys si está activo).
- `payment_methods.stripe_account_id` y `network_txn_id` (pago por referencia de Redsys); `payments.stripe_account_id` + `application_fee_amount`.
- `redsys_settings.card_on_file_enabled`, `redsys_orders.save_card`.

### Cupones (`20261025100000` – `20261026100000`)

- **`coupons`** (RLS): código, tipo (porcentaje / importe fijo / meses gratis con mínimo de meses), condiciones (tipos, locales, meses mínimos, importe mínimo, solo clientes nuevos, `once_per_customer`), fechas y usos.
- **`coupon_redemptions`** (RLS): un uso por contrato.
- `contracts.first_payment_months` (1, 3, 6 o 12; meses que cubre la primera factura).

### Landings de promoción (`20261026120000` – `20261026140000`)

- **`promo_landings`** (RLS): `/promo/<nombre>` con textos, foto, ventajas, condiciones, cupón opcional, locales y tamaños, secciones, fechas, SEO e `indexable` (false por defecto).
- **`promo_landing_visits`** (RLS, sin datos personales): id aleatorio del navegador + UTM.
- `marketing_channels.promo_landing_id` (FK SET NULL): enlaces y QR de cada origen.

### Rendimiento de los anuncios (`20261108140000`)

- **`ad_metrics_daily`** (RLS): impresiones, clics, gasto y conversiones por canal de anuncios y día.

### Instagram y Facebook (`20261108180000`)

- **`tenant_social_accounts`**, **`social_daily_metrics`** y **`social_posts`** (RLS): página y cuenta de Instagram del tenant, métricas por red y día y publicaciones recientes.

### Resumen de marketing (`20261108160000`)

- **`tenants.marketing_report_enabled`** / **`marketing_report_last_month`**: correo mensual «Tu marketing en <mes>».

### Google Analytics 4 (`20261108120000`)

- **`tenant_ga4`**, **`ga4_source_rows`**, **`ga4_page_rows`** (RLS): conexión y datos diarios de la propiedad de GA4 del tenant.

### Analítica propia de la web (`20261108100000`)

- **`web_events`** (RLS, sin datos personales): páginas vistas y clics de contacto con su origen y dispositivo.

### Web del tenant (`20261027100000` – `20261028100000`)

- `tenants.web_favicon_key` (favicon de la web pública) y `tenants.web_legal` (aviso legal, privacidad y cookies).

### Panel super admin (`20261029100000` – `20261029140000`)

- `impersonation_logs.read_only` (`20261029100000_impersonation_read_only`): la sesión de soporte solo puede leer; el token lleva rol `readonly`.
- `platform_alert_settings` (`20261029120000_platform_chat_alerts`): `telegram_bot_token_encrypted`, `telegram_chat_id`, `slack_webhook_url_encrypted` (cifrados AES-GCM), `chat_daily_enabled`, `chat_weekly_enabled`.
- **`admin_approval_requests`** (`20261029140000`, global, REVOKE): `tenant_id`, `requested_by_id`/`decided_by_id` (FK a `super_admins`, SET NULL), `action` (suspend, change_plan, extend_trial, manual_payment, set_features, update_tenant, assign_addon, remove_addon), `payload` jsonb (los mismos datos que el endpoint de cada acción), `reason`, `status` (pending/approved/rejected/failed), `decision_note`, `error`, `decided_at`.

### Pagos del SaaS y análisis completo (`20261030100000` – `20261031120000`)

- `platform_sepa_remittance_items` (`20261030100000_platform_sepa_retry_bounced`): el único `(tenant, periodo)` pasa a índice parcial sobre `pending`/`collected` (un adeudo devuelto se puede reintentar).
- `tenants.auto_end_contracts` (`20261031100000`, por defecto `true`): el contrato en baja se finaliza solo el día siguiente a su fecha de fin.
- `invoices.charge_held_at` y `communications.held_at` (`20261031120000_suspension_holds`, índices parciales): cobro automático y envío retenidos mientras el tenant estaba suspendido; el cron `suspension-holds.release` los libera al reactivarse (envíos de más de 30 días → `skipped`).

### Paneles admin y del tenant, portal (`20261101100000` – `20261104100000`)

- `tenants.web_header_branded` (bool): cabecera de la web pública con el color de marca.
- `tenant_feature_overrides.expires_at` / `trial_addon_id` (FK a `subscription_addons`, SET NULL) / `expiry_notified_at`: cortesías y pruebas de extras con fecha; origen nuevo `trial`.
- **`feature_interest_events`** (RLS): `user_id`, `feature`, `path` — el tenant pulsó una función que no tiene.
- `platform_alert_settings.chat_commercial_enabled` / `chat_commercial_last_at` (avisos comerciales por Telegram/Slack) y `send_activation` (correos de activación días 3/7/12).
- **`payment_plans`** (RLS): `customer_id`, `status` (active/completed/broken/cancelled), `invoice_ids` UUID[] (GIN), `total_amount`, `paid_at_start`, `installments` jsonb, `grace_days`; con un plan activo y al día el escalado, los reintentos y la remesa no tocan esas facturas.
- **`customer_interest_events`** (RLS): `customer_id`, `kind` (seguro, trastero adicional o más grande, pase nocturno), `unit_type_id` — miró en el portal y no contrató.
- **`customer_offers`** (RLS): `kind`, `title`, `message`, `price_gross`, `status` (open/interested/declined/accepted/expired), `seen_at`, `responded_at`, `accepted_at`, `expires_at` — propuestas de Oportunidades que ve el inquilino en el portal.
- `customers.portal_last_seen_at`: última visita al portal (como mucho una anotación por hora).
- `dunning_actions.superseded_at`: acción sustituida; el índice único de acciones activas la excluye.

### Páginas de zona y SEO local (`20261105100000` – `20261107120000`)

Extra `local_seo` (solo de venta aparte). Tablas de tenant con RLS.

- **`web_area_pages`**: `slug` (único por tenant), `name`, `facility_ids` UUID[], `nearest_note`, `intro`, `nearby_areas` TEXT[], `faqs` jsonb, `seo_title`, `seo_description`, `is_published`. Las páginas de ciudad se generan solas; esta tabla guarda el texto propio y las zonas cercanas.
- `20261106100000_local_seo_courtesy`: override `local_seo` (`manual`) para los tenants con páginas de zona publicadas.
- **`tenant_search_console`** (una por tenant): `site_url` (`sc-domain:…` o `https://…/`), `status` (pending/connected/error), `last_error`, `connected_at`, `last_synced_at`, `monthly_report` (por defecto sí), `last_report_month` (`AAAA-MM`, no se repite el informe).
- **`search_console_rows`**: `date`, `query`, `page`, `clicks`, `impressions`, `position` (media del día) — búsquedas descargadas de Google; se guardan unos 16 meses.

### Revisión del CRM (2026-10-24, migración `20261112100000_crm_review`)

- `referrals.reward_type` / `reward_value` / `reward_applied_at` / `reward_invoice_id` (FK invoices SET NULL): la recompensa del que recomienda se descuenta una vez del alquiler de su siguiente factura recurrente (reserva atómica; si la factura falla, se libera).
- `reviews.published_on_web`: solo las valoraciones publicadas por el equipo salen como testimonios en la web pública.

### Funcionalidades del CRM (2026-10-25, migración `20261112120000_crm_features`)

- `lead_followups` (RLS): recordatorios con fecha de un contacto (`pending`/`done`). `lead_activities` (RLS): llamadas, visitas y notas.
- `leads.unattended_notified_at`; `tenants.lead_response_hours` (4) y `lead_auto_assign` (`off`|`round_robin`|`facility`).
- `campaign_links` (RLS, único por campaña y posición) y `campaign_clicks` (RLS, único por enlace y destinatario `c:<id>`/`l:<id>`).
- `campaign_templates` (RLS): asunto y mensaje reutilizables.
- `reviews.google_requested_at`.
- `winback_sends.step` (1|2, único por tenant, cliente y paso) y `tenants.winback_second_*` (activado, días, asunto, mensaje, cupón).

### Funcionalidades de Inventario (2026-10-25, migración `20261113100000_inventory_features`)

- `products.min_stock` (null = sin aviso de reponer).
- `product_stock_movements` (RLS): cada entrada o salida de stock (`adjust`, `set`, `sale`, `sale_cancelled`) con local, cantidad, stock resultante (en ajustes), venta y usuario.
- `facility_documents` (RLS): documentos internos del local (`licence`, `insurance`, `lease`, `inspection`, `other`) en el bucket privado `uploads` (`<tenant>/facilities/<local>/documents/`), con `expires_on` y `expiry_notified_at` (un aviso por fecha).
- `units.maintenance_until`: vuelta prevista al servicio de un trastero en mantenimiento (se borra al salir de mantenimiento).

### Funcionalidades de la Operativa (2026-10-25, migración `20261114100000_operations_features`)

- `notifications.user_id` (FK CASCADE): aviso para una sola persona (p. ej. a quien se le asigna una tarea); null = para el equipo que ve su local.
- `tenants.task_auto_rules` (jsonb): tareas automáticas (bienvenida, revisión tras la salida, llamada para renovar); null = apagadas.
- `reservations.deposit_invoice_id` (FK SET NULL a `invoices`): factura de la señal.
- `contracts.pending_credit_amount` / `pending_credit_reason`: descuento pendiente (la señal cobrada) que se resta una vez del alquiler de la siguiente factura.
- Tabla `customer_authorized_persons` (RLS): personas autorizadas por el inquilino (nombre, documento, teléfono, relación, puede entrar / recoger / gestionar, notas). Se borran al anonimizar al inquilino o al tenant.
- `contracts.end_date_before_ending` (migración `20261122100000_portal_review`): fecha de fin que tenía el contrato antes de pedir la baja; se devuelve al cancelarla.
- Migración `20261123100000_portal_improvements`: `unit_change_requests.target_unit_id` (FK SET NULL a `units`, el trastero libre que elige el inquilino) y `desired_date`; `customers.whatsapp_opt_out_at` (no quiere avisos por WhatsApp: el outbox los deja `skipped`); `redsys_orders.extra_invoice_ids UUID[]` (otras facturas del mismo inquilino pagadas en la misma orden, «Pagar todo»).

### Vencimientos y avisos (2026-10-29, migración `20261124100000_business_reminders`)

- `business_reminders` (RLS): título, `category`, `due_date` (DATE), `recurrence` + `interval_months`, `notify_days_before` INT[] (por defecto 30/7/1/0), `notify_email`/`notify_in_app`/`notify_push`, `recipient_mode` (`managers`|`users`) + `recipient_user_ids` UUID[], `extra_emails` TEXT[], `overdue_reminders` + `overdue_max_days` (7), `amount`, `vendor`, `link`, `notes`, `facility_id` (SET NULL; null = toda la empresa), `status` (`active`|`paused`|`done`), `snoozed_until` (DATE), `template_key` (`fiscal_303:4-20`, `business_domain`…) y `created_by_user_id` (SET NULL).
- `business_reminder_completions` (RLS): cada vez que se marca hecho — fecha que vencía, quién y cuándo, nota, importe, `expense_id` (SET NULL) y justificante (`receipt_key` en `uploads`, nombre y tipo).
- `business_reminder_notices` (RLS): avisos enviados, único por (`reminder_id`, `due_date`, `kind`); `kind` = `d<días>`, `overdue:<fecha>` o `snooze:<fecha>`.
- `tenants.reminders_weekly_digest` (false), `reminders_digest_last_date`, `reminders_ics_token_hash` (único, sha256 del token del calendario) y `reminders_ics_token_encrypted` (AES-GCM, AAD = tenant, para volver a enseñar el enlace).
- Planes: la migración añade `business_reminders` a `subscription_plans.tenant_features` de `starter`, `pro` y `administrador`.

### Negocio del panel admin (2026-10-29)

- `platform_business_goals` (global, REVOKE, un registro): `mrr_target`, `signups_target_monthly`, `trial_conversion_target_pct`, `target_date`, `updated_at`.
- `tenant_health_snapshots` (global, REVOKE): `tenant_id` (FK CASCADE), `month` (DATE, primer día), `score`, `level`; único `(tenant_id, month)`. Se reescribe la del mes en curso al calcular la salud de todos los tenants.
- `platform_alert_settings` += `business_alerts_enabled`, `alert_mrr_drop_pct`, `alert_churn_pct`, `alert_ai_cost_usd_week`, `alert_big_tenant_mrr`.

### Condiciones generales aceptadas (2026-10-29)

- `legal_doc_versions` (RLS): `tenant_id`, `doc` (`condiciones-contratacion`), `version` (1, 2…), `title`, `content` (Markdown tal cual se aceptó), `content_hash` (SHA-256); únicos `(tenant_id, doc, version)` y `(tenant_id, doc, content_hash)`. Inmutable.
- `legal_doc_acceptances` (RLS): `version_id` (FK RESTRICT), `customer_id` (CASCADE), `contract_id` (SET NULL), `channel` (`remote` | `in_person`), `ip_address`, `user_agent`, `accepted_at`.

### Mejoras del apartado Tenants del panel admin (2026-10-29)

- `super_admin_saved_views` (global, REVOKE): vistas guardadas de las listas del panel admin por super admin (`page`, `name`, `filters` jsonb; único por super admin + página + nombre).
- `tenant_followups.assigned_to_id` (FK SET NULL a `super_admins`): quién se encarga del seguimiento.
- `tenants.risk_snoozed_until` / `risk_snooze_reason`: «ignorar» el tenant en la lista En riesgo hasta esa fecha.

### Chat con IA de la web pública (2026-10-29)

- `web_chat_conversations` (RLS): una por tenant y visitante (`visitor_id`, id aleatorio del navegador; sin datos personales), idioma, página, `lead_id` (FK SET NULL si dejó sus datos), nº de mensajes y último mensaje. Se borran 90 días después del último mensaje y al anonimizar el tenant.
- `web_chat_messages` (RLS): `role` visitor | assistant, `content`, `fallback` (respuesta de respaldo sin IA: límite, sin clave o error; no cuenta como respuesta del asistente).
- `tenants.web_chat_enabled` (por defecto sí), `web_chat_instructions`, `web_chat_monthly_limit` (null = el general), `web_chat_limit_notified`, `web_chat_key_notified` (aviso mensual de que falta la clave propia).
- `platform_ai_settings.web_monthly_limit` (300), `web_visitor_daily_limit` (15), `web_model` (null = `claude-haiku-5-5`).
- `ai_usage_events.feature = 'web_chat'`: respuestas del chat de la web; cuentan para su propio límite, no para el del panel.
