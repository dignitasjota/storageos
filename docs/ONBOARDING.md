# ONBOARDING — Puesta en marcha con el primer cliente real

Checklist accionable para pasar de "desplegado en un dominio de prueba" a
**operando de verdad con un cliente**. Casi todo es **configuración** (variables
de Portainer/`.env.prod` + DNS + redeploy), **no código**. El detalle paso a
paso de cada bloque está en [`DEPLOYMENT.md`](DEPLOYMENT.md) (se cita la sección
`§`).

Marca cada casilla al completarla. Orden recomendado: **Fase 1 (imprescindible)
→ Fase 3 (alta del cliente) → Fase 4 (verificación)**; la Fase 2 es opcional
según lo que use el cliente.

> Todas las variables de servicio (passwords, etc.) deben ser **alfanuméricas**:
> la validación `z.string().url()` de algunas rechaza `/`, `+`, `=`.

---

## Fase 0 — Pre-requisitos

- [ ] **VPS desplegado** y stack vivo en Portainer (api, web, worker, postgres, redis, minio). → `DEPLOYMENT.md §1–6`.
- [ ] **Dominio definitivo** contratado, con acceso al panel DNS.
- [ ] **Subdominios** apuntando al VPS (A/AAAA) y con cert SSL en Nginx Proxy Manager:
  - `app.<dominio>` → web (`web:3000`)
  - `api.<dominio>` → api (`api:3001`)
  - (opcional) `grafana.<dominio>` si activas observabilidad.
- [ ] Variables de URL coherentes con el dominio definitivo (Portainer):
  - `NEXT_PUBLIC_API_URL=https://api.<dominio>`
  - `NEXT_PUBLIC_SITE_URL=https://app.<dominio>` (sitemap/robots/landing)
  - `WEB_BASE_URL=https://app.<dominio>` y `API_BASE_URL=https://api.<dominio>` (enlaces de email, notificación Redsys)

---

## Fase 1 — Imprescindibles para operar (lista roja)

### 1. Despliegue automático en cada merge → `DEPLOYMENT.md §6C`

- [ ] Crear un **webhook de redeploy** del stack en Portainer.
- [ ] Guardar su URL como secret de GitHub Actions: `PORTAINER_WEBHOOK_URL`.
- [ ] Verificar: un merge a `main` reconstruye y sirve el código nuevo (sin esto, riesgo de servir el frontend viejo por cache del `COPY`).

### 2. Bootstrap: planes + super admin → `DEPLOYMENT.md §7`

- [ ] Variables `BOOTSTRAP_SUPERADMIN_EMAIL` + `BOOTSTRAP_SUPERADMIN_PASSWORD`.
- [ ] Ejecutar el servicio one-shot `bootstrap` (o `node dist/scripts/bootstrap.js`). Idempotente: siembra planes `free/starter/pro` (el registro exige `starter`) + crea el super admin.
- [ ] Entrar en `https://app.<dominio>/admin/login` y activar **2FA** del super admin (`/admin/security`).

### 3. Email transaccional (Resend) → `DEPLOYMENT.md §10.5`

- [ ] Crear cuenta + dominio en Resend y verificar **SPF/DKIM** (registros DNS).
- [ ] API key + variables:
  - `EMAIL_PROVIDER=resend`
  - `EMAIL_FROM_NAME=<NombreComercial>`
  - `EMAIL_FROM_ADDRESS=no-reply@send.<dominio>`
  - `RESEND_API_KEY=re_...`
- [ ] Verificar: `POST /auth/password/forgot` llega a una bandeja real (no spam) con `spf=pass dkim=pass dmarc=pass`.
- [ ] (Tras 7 días) endurecer DMARC a `p=quarantine`/`reject`.

### 4. Stripe live (suscripción SaaS + cobros) → `DEPLOYMENT.md §12C`

- [ ] Activar la cuenta Stripe (datos fiscales/bancarios) y pasar el dashboard a **modo live**.
- [ ] Variables en el servicio **api** (no en web):
  - `STRIPE_SECRET_KEY=sk_live_...`
  - `STRIPE_PUBLISHABLE_KEY=pk_live_...`
- [ ] Crear el **webhook** `https://api.<dominio>/webhooks/stripe` con los eventos: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `setup_intent.succeeded`, `customer.subscription.{created,updated,deleted}`, `invoice.payment_{succeeded,failed}`.
- [ ] Copiar el signing secret → `STRIPE_WEBHOOK_SECRET` (api).
- [ ] En NPM, la _custom location_ `/webhooks/stripe` con body ≥ 5 MB y sin caché (Stripe firma el raw body).
- [ ] Redeploy + verificar que la última entrega del webhook responde `200`.
- [ ] Crear/ajustar el **catálogo de planes** desde `/admin` (super admin) — precios reales del SaaS.

### 5. Veri\*Factu / AEAT en producción → `DEPLOYMENT.md §11`

- [ ] Variables del sistema informático (comunes a todos los tenants): `AEAT_SISTEMA_NIF/NOMBRE/VERSION/INSTALACION`, `AEAT_SANDBOX_ENDPOINT`, `AEAT_PRODUCTION_ENDPOINT`, `AEAT_TIMEOUT_MS`.
- [ ] Subir el **certificado FNMT** del tenant (PKCS#12) en `/settings/billing/verifactu` del panel del cliente.
- [ ] `AEAT_MODE=sandbox` para el dry-run; cuando valide, `AEAT_MODE=production`. Recrear el api.
- [ ] Verificar: emitir una factura → `<VerifactuBadge>` pasa a `Aceptada (CSV: …)`.

### 6. Worker separado del API → `DEPLOYMENT.md §12`

- [ ] Servicio `worker` arriba en el stack de producción.
- [ ] En el **api**: `ENABLE_WORKERS_IN_API=false` (los crons/processors corren en el worker).
- [ ] Verificar `https://api.<dominio>/health/worker` → `200` (heartbeat fresco).

### 7. Monitorización → `DEPLOYMENT.md §13`

- [ ] **Sentry**: `SENTRY_DSN` (misma en api y worker); opcional `SENTRY_TRACES_SAMPLE_RATE`.
- [ ] **Uptime Kuma** vigilando: `app.<dominio>`, `api.<dominio>/health/ready`, `api.<dominio>/health/worker`.
- [ ] (Opcional) revisar `/admin/queues` («Sistema y colas») del panel: estado de Postgres/Redis/MinIO/worker + jobs fallidos.

### 8. Backups → `DEPLOYMENT.md §10`

- [ ] Cron de backup de **Postgres** (dump cifrado) a almacenamiento externo (p. ej. Backblaze B2).
- [ ] (Recomendado) backup de los **buckets MinIO** privados (documentos de clientes, PDFs de contratos/facturas).
- [ ] Probar una **restauración** al menos una vez.

---

## Fase 2 — Opcionales (según lo que use el cliente)

- [ ] **WhatsApp Business** (Meta Cloud API) → `§15`: `WHATSAPP_PROVIDER=meta_waba` + credenciales Meta + plantillas WABA aprobadas. (Sin esto, dunning/avisos por WhatsApp quedan en stub.)
- [ ] **Holded** (export contable) → `§16`: se configura por tenant en `/settings/billing` (API key cifrada). Sin variables globales.
- [ ] **Redsys** (TPV bancario) → `§17`: config por tenant cifrada en `/settings/billing`; requiere `API_BASE_URL` (URL de notificación) ya fijada en Fase 0.
- [ ] **SEPA (remesas pain.008 + conciliación N43)**: 100% en producto, sin variables; el cliente configura el acreedor + mandatos en el panel.
- [ ] **Push (Web Push/PWA)**: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `VAPID_SUBJECT` (mismas en api **y** worker).
- [ ] **Asistente IA**: `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (+ `AI_MODEL`, default `claude-sonnet-4-6`). Sin esto corre el stub (dev) o devuelve `ai_not_configured`.
- [ ] **Observabilidad Loki/Grafana** → `§13.1`: `COMPOSE_PROFILES=observability` + `GF_ADMIN_PASSWORD`/`GF_SMTP_*` + Proxy Host `grafana.<dominio>`.
- [ ] **Inbound de mensajes** (respuestas del inquilino por WhatsApp/email al chat): `WHATSAPP_VERIFY_TOKEN` + `WHATSAPP_APP_SECRET` (webhook `/webhooks/whatsapp` en Meta) y/o `EMAIL_INBOUND_SECRET` (routing entrante del proveedor a `/webhooks/email-inbound`).
- [ ] **Dominio propio del tenant (white-label)** → `§18`: solo para clientes del plan `pro` (o con la feature `custom_domain` por override). El cliente añade su dominio en `/settings/branding` + crea el DNS; tú creas el **Proxy Host + SSL en NPM** y lo **activas** en `/admin/custom-domains`. Sin variables globales. **Cobro del extra**: si no está incluido en su plan, ajusta el precio de su suscripción (Stripe dashboard) o regístralo como pago manual con nota.

---

## Fase 3 — Alta del primer cliente (tenant)

- [ ] El cliente se **registra** en `https://app.<dominio>/register` (crea su tenant en `starter`) **o** lo das de alta tú e invitas al owner.
- [ ] Como **super admin** (`/admin/tenants/<id>`): ajustar **plan**, editar datos (nombre, email de facturación, país, divisa, zona horaria, **NIF/CIF**) y, si procede, extender trial.
- [ ] El cliente configura en su panel:
  - [ ] **Datos fiscales** + **serie de facturación** (`/settings/billing`).
  - [ ] **Certificado AEAT** (FNMT) para Veri\*Factu (ver Fase 1.5).
  - [ ] Pasarela de cobro (Stripe self-service de IBAN/tarjeta, y/o Redsys, y/o SEPA acreedor).
  - [ ] Sus **locales, tipos de trastero, trasteros** (o importación CSV desde su software anterior: `/units/import`, `/customers/import`, `/contracts/import`).
  - [ ] **Usuarios** de su equipo (invitaciones) con roles/permisos y, si aplica, scope por local.
- [ ] (Recomendado) Forzar **2FA** a owner/manager del tenant (`/settings/security`).

---

## Fase 4 — Verificación end-to-end (smoke)

- [ ] **Auth**: registro → email de verificación recibido → login → 2FA.
- [ ] **Facturación**: alta de inquilino + contrato → emitir factura → Veri\*Factu `Aceptada` → PDF + QR correctos.
- [ ] **Cobro**: el inquilino paga desde el portal (tarjeta/SEPA/Redsys) → la factura pasa a `paid`; o registra el cobro por remesa SEPA/N43.
- [ ] **Dunning**: una factura vencida dispara el recordatorio por email (y WhatsApp si configurado).
- [ ] **Suscripción SaaS**: el tenant paga su plan (Stripe) → el super admin lo ve en `/admin/tenants/<id>` (pestaña Pagos) y en `/admin/metrics` (MRR).
- [ ] **Worker/colas**: `/admin/queues` sin fallidos acumulados; `/health/worker` ok.
- [ ] **Salud**: Uptime Kuma en verde en los 3 monitores.

---

## Notas

- El **catálogo de planes** SaaS se gestiona en `/admin` (super admin); no hay variables de `price_id`.
- Tras cambiar variables en Portainer, **recrear** el contenedor afectado (`up -d --force-recreate <servicio>`).
- Cualquier **migración** de BD pendiente se aplica con el bootstrap/`migrate deploy` antes del arranque (las features marcan en `CLAUDE.md` si traen migración).
- Lista de "lo que falta" a nivel producto (backlog opcional) en [`ROADMAP.md`](ROADMAP.md).
