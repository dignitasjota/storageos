# Auditoría en profundidad — julio 2026

Análisis del proyecto completo realizado el **2026-07-02** con 4 auditorías paralelas
(seguridad/multi-tenancy, dinero/facturación, frontend/UX, infra/testing) sobre el
código real. Este documento recoge el diagnóstico, lo ya **solucionado** y lo
**pendiente**, para que sirva de checklist vivo.

**Veredicto general**: el proyecto está en muy buen estado. La seguridad salió
notablemente limpia (webhooks con firma + idempotencia, RBAC completo, RLS,
secretos cifrados AES-GCM, cadena de guards correcta). Los hallazgos fueron bugs
de segunda línea y deuda de consistencia.

---

## ✅ Solucionado

### CI — OOM crónico del e2e (PR #204)

Las 100+ suites e2e en un solo proceso `jest --runInBand` acumulaban una fuga de
memoria que agotaba el heap (ya estaba en 6 GB) de forma intermitente, tumbando la
mayoría de reruns del gate. **Fix**: el job corre **3 shards secuenciales**
(`jest --shard=N/3`) — cada shard es un proceso nuevo, el heap se libera entre
ellos. Mismo nombre de check (branch protection intacta). Verificado: pasó a la
primera tras semanas de reruns.

### Frontend — modo oscuro roto + accesibilidad (PR #208)

- ~20 sitios usaban combos de fondo claro + texto oscuro (`bg-*-100 text-*-600/700`,
  `bg-*-50`, `bg-slate-200`) **sin variante `dark:`** → ilegibles en oscuro: home
  móvil del staff, accesos rápidos del portal, KPI tiles, badges de estado
  (accesos/tareas/incidencias/hoy/analytics), admin (salud/adopción/seguimientos),
  banner de plataforma, cajas ámbar, página de firma. Añadidas variantes
  `dark:bg-*-950 dark:text-*-300`. Los `bg-white` de los contenedores de QR se
  conservan a propósito (escaneabilidad).
- **25 `aria-label`** añadidos a botones solo-icono (menús de acciones, copiar,
  eliminar, zoom del plano…).
- _Gotcha_: insertar atributos JSX con regex `<Button[^>]*?>` se rompe con los `=>`
  de arrow functions en props — hace falta un escáner que cuente llaves.

### Backend — dinero en céntimos + IVA por línea + UTC (PR #209)

- El core (invoices/payments) usaba los helpers de `apps/api/src/common/money.ts`
  (céntimos enteros), pero los módulos posteriores restaban/sumaban decimales a
  pelo: **SEPA pain.008** (¡el fichero que va al banco!), **Redsys**,
  **conciliación N43**, **dunning** (importe del email), **payments**
  (`amountCents`), **late fees**. Todos migrados a `toCents`/`subtractAmounts`.
- **IVA por línea (riesgo AEAT)**: `computeTotals` redondeaba la cuota **global**
  mientras cada `invoice_item` la guarda redondeada **por línea** → con varias
  líneas la cabecera difería céntimos de la suma de items (riesgo de rechazo
  Veri\*Factu). Ahora cabecera = suma exacta de líneas redondeadas
  (`invoice.total ≡ Σ items.total`). e2e `invoice-rounding` cubre el caso donde
  ambos criterios difieren (2 × 1.55 € al 21% → 0.66 vs 0.65).
- `computeDefaultDueDate`: `setDate` (TZ local del servidor) → `setUTCDate`.

### Backend — guardas de robustez (PR #210)

- 🐛 **Bug latente descubierto al testear**: el unique
  `(tenant, series, sequence_number)` con drafts a `sequence_number=0` solo
  permitía **UN borrador por serie** → la facturación recurrente con 2+ contratos
  activos habría fallado en el segundo (habría explotado el primer día 1 de mes
  con un cliente real). Fix: índice **parcial** `WHERE sequence_number > 0`
  (la numeración solo es única en facturas emitidas). Migración `20260702140000`.
- **`cron_runs`** (tabla global): cada cron diario «reclama» su ejecución con un
  INSERT `(name, run_on)`; la PK garantiza un solo ganador entre réplicas. Helper
  `claimDailyCronRun` aplicado a los 2 crons que corren sin gatear en el API
  (`PlatformDunningCron`, `PlatformAlertsCron`) → sin dunning/digests duplicados
  al escalar el API a 2+ réplicas.
- **TOCTOU de la recurrente**: índice parcial `invoices_recurring_period_unique`
  (una F1 viva por tenant+contrato+period_start; no afecta a R\*, canceladas ni
  borradas) + catch P2002 en el job (skip) + 409 `duplicate_period_invoice` en el
  create manual.
- **TOCTOU del dunning**: índice parcial `dunning_actions_active_unique` (una
  acción activa por factura+tipo; las canceladas conviven) + catch P2002.
- **Promociones**: claim **atómico** del uso (`updateMany` condicionado a
  `usedCount < maxUses`) — dos altas concurrentes ya no superan el límite.
- **Healthcheck del worker**: script `apps/worker/src/healthcheck.ts` (verifica el
  latido `workers:heartbeat` en Redis) wired en ambos composes de prod — un worker
  colgado pasa a `unhealthy` en Portainer en vez de morir en silencio.
- **`apps/api/.env.example` completado** (19 variables sin documentar: sistema
  informático AEAT, super admin JWT/TTLs, `API_BASE_URL`, `LOCK_PROVIDER`/MQTT,
  WhatsApp, retención de webhooks, `REDIS_PASSWORD`).

### Testing — smoke Playwright del flujo navegador del portal (PR de este punto)

Nuevo `apps/web/e2e/06-portal-consume.spec.ts`: el staff genera el magic link →
un navegador real lo consume → la sesión carga las facturas con el **header
manual `Authorization`** (el camino exacto del bug histórico de `apiFetch` que
dejó el portal roto en producción sin que ningún test lo viera) → navega a
Facturas y ve la factura emitida → la recarga restaura la sesión de
localStorage. Corre en el gate de CI con los otros 5 smoke tests.

### Testing — unit tests de `billing-saas.service` (12 specs)

`__tests__/billing-saas.service.spec.ts`: pagos manuales (extiende desde el fin
de periodo futuro / desde AHORA si está vencida, acumula `manualExtensionDays`,
ajuste de fin de mes 31 ene → 28 feb, 404 sin suscripción), sync de Stripe
(SUMA el crédito manual al periodo del webhook, mapeo de status, tenant no
resoluble = no-op) y registro de facturas de Stripe (céntimos→euros, upsert
idempotente por `external_id` sin re-facturar, race P2002 tragada, pagos no
cobrados sin factura del SaaS).

### Hardening + operabilidad — puntos 2-6 del pendiente (PRs #214-#216)

- **#214** — `PORTAL_JWT_SECRET` dedicado (fallback a `JWT_2FA_PENDING_SECRET`,
  helper `portalSecret()` en Portal/Signatures) + **webhook Redsys con body
  raw** parseado estricto por content-type (solo strings planos, fuera qs).
- **#215** — `mem_limit` en api/worker/web (1g/1g/512m) en ambos composes +
  **`RedisMemoryCron`** (log `redis_memory_high` al superar el 80% de
  maxmemory) + alerta Grafana `redis-memory-high` (con `noeviction` Redis
  rechaza escrituras al llenarse y las colas fallan en silencio).
- **#216** — `twoFactorSecret` → `twoFactorSecretEncrypted` (solo el campo
  Prisma; el `@map` conserva la columna → sin migración).

### Testing — unit tests de `portal.service` (9 specs)

`__tests__/portal.service.spec.ts`: round-trip completo del magic link con
Redis falso (URL → consume → sesión verificable → replay 401 single-use),
TTL 7 días del enlace del staff + auditoría sin token, 404 sin guardar nada,
secreto que no casa con el hash, **secret dedicado del portal** (un token
firmado con el secret de 2FA NO vale cuando `PORTAL_JWT_SECRET` está definido;
sin definir cae al fallback), purpose/expiración rechazados, y
anti-enumeración de `requestMagicLink` (silencioso sin filtrar).

---

## ⏳ Pendiente (priorizado)

1. **Unificar i18n del panel tenant** — mezcla de `useTranslations` y textos
   hardcodeados (toasts, títulos). Esfuerzo grande; solo tiene sentido si entra
   el multi-idioma EN/CA del backlog.

## ❌ Falsos positivos descartados (no tocar)

- **Redis `maxmemory-policy noeviction`**: una auditoría sugirió `allkeys-lru` —
  **incorrecto**: con BullMQ la política DEBE ser `noeviction` (desalojar claves
  pierde jobs). La mejora real (alertar memoria) ya está: `RedisMemoryCron` + alerta Grafana (#215).
- **`useQueryClient()` en deps de `useEffect`**: el cliente es estable entre
  renders (React Query lo garantiza); no es una fuga.
- **`bg-white` en contenedores de QR** (2FA, acceso del portal): intencionado —
  el QR necesita fondo claro para escanearse.
- **Los `@Public()` del backend**: todos verificados — cada uno tiene su propia
  autenticación (sesión de portal, firma de webhook, AdminGuard o throttle).

---

# Auditoría 2 — pagos y permisos (julio 2026, 2026-07-08/09)

Segunda pasada dirigida (3 agentes en paralelo: **dinero**, **permisos/aislamiento**,
**flujos de negocio**), verificando cada hallazgo línea a línea antes de tratarlo
como real. Foco en concurrencia de dinero y aislamiento por local. **Todos los
hallazgos críticos/altos quedaron cerrados** (9 PRs).

## ✅ Solucionado

- **Permisos / facilityScope** (`fix/authz-scope-gaps`, #300): `payments.chargeInvoice`/
  `bulkCharge` no aplicaban el alcance por local (cobro cross-local); el cierre de caja
  **global** se saltaba el scope (→ 400 `facility_required` si el usuario tiene scope);
  `PUT /admin/tenants/:id/features` sin `@RequireSuperadmin` (un `support` activaba
  features de pago gratis); `reservations.create` y `generate-pdf` sin scope; `GET
/invoices` sin `@RequirePermission`.
- **`contract_ended` no se emitía nunca** (`fix/contract-ended-revoke-access`, #301):
  evento cableado pero muerto → **el PIN de acceso del ex-inquilino seguía vivo tras la
  baja** + automatizaciones de fin de contrato inertes. Ahora `end()`/`cancel()` lo
  emiten y `AccessIntegrationsService` revoca las credenciales si no queda contrato vivo.
- **Anti-doble-cobro** (`fix/payment-in-flight-guard`, #302): índice único parcial
  `payments_one_live_gateway_charge` (1 cobro de pasarela vivo por factura) + advisory
  lock en `chargeInvoice` (el doble clic da 409 sin llamar al gateway) + guard SEPA en
  `markPaidManually` (409 salvo `overridePaymentInFlight`) + parciales solo en efectivo.
  Reglas de negocio acordadas con Jota.
- **Dedup del webhook de GoCardless** (`fix/gocardless-webhook-dedup`, #303): tabla
  `processed_gocardless_events` (patrón de Stripe) → un `confirmed` reentregado ya no
  suma dos veces al `amountPaid`.
- **`amountPaid` atómico + refund multi-pasarela** (`fix/amountpaid-atomic-refund`, #304):
  `increment` atómico en `syncFromWebhook` (fin de lost-updates concurrentes); reembolsar
  un cobro GoCardless/SEPA da 400 claro en vez de un 500 (el gateway inyectado es Stripe).
- **Idempotencia de la notificación Redsys** (`fix/redsys-idempotency`, #305): la
  transición de la order a `paid` pasa a `updateMany(where status:pending)` → solo la 1ª
  notificación cobra; la duplicada no crea un 2º Payment.
- **Anti-doble-ocupación del trastero** (`fix/contract-unit-double-occupancy`, #308):
  índice único parcial `contracts_one_active_per_unit` + advisory lock en `sign()` y
  `changeUnit()` → dos firmas/traslados concurrentes sobre la misma unidad ya no dejan
  dos contratos activos en el mismo trastero.

## ✅ Resuelto (antes en «Pendiente»)

1. **Arqueo de caja** → `fix/cash-closure-refunds-sales`: los reembolsos en efectivo restan
   del esperado y las ventas sin contrato entran en la caja por local.
2. **Conciliación N43** → `fix/n43-partial-amount`: `matchTransaction` aplica el importe real
   del apunte (parcial deja saldo pendiente).
3. **Cargo huérfano** → `#321`: el cargo por pasarela sale fuera de la transacción del
   `payment.create`.
4. **`end()`/`cancel()`** → `#320`: cancelan las `dunning_actions` `scheduled` del contrato +
   alerta de fianza sin liquidar en «Hoy».
5. **Rol `support`** → `fix/admin-support-monetization-guard`: `revoke-sessions`/`extend-trial`
   ya exigían `@RequireSuperadmin` (verificado); se cierra además `custom-domain verify/revoke`
   (white-label = feature de pago) como superadmin-only.

## ✅ Resuelto (cont.)

5. **Fianza** → `feat/collections-deposit-settlement`: `completeDisposal` aplica la fianza
   retenida + lo obtenido de la disposición a las facturas pendientes por antigüedad (más
   antigua primero) vía `markPaidManually` y marca la fianza liquidada; el sobrante queda
   documentado en el evento `disposal_done`. Checkbox «Aplicar fianza» en `/collections/:id`.

## ⏳ Pendiente (menor, priorizado)

7. ~~**Tokens de staff** no revalidan el estado del tenant (suspendido/cancelado) hasta que
   expira el access token~~ ✅ **Resuelto en #319**: `TenantStatusGuard` (APP_GUARD) revalida
   el estado del tenant en cada request.

## Mejoras de valor propuestas (agente de negocio)

Cobro recurrente automático con reintentos (smart dunning) · waitlist por tipo de trastero ·
motor de retención sobre bajas/`ending` · reconciliación de inventario (cron) · rent
increase con tope anual + no solapar subidas.

---

# Auditoría 4 — seguridad (septiembre 2026, 2026-09-25)

Pasada completa de seguridad sobre el código actual (auth/JWT, guards, RLS,
peticiones salientes, webhooks, ficheros, logs, dependencias). Tres hallazgos
graves que las pasadas anteriores no detectaron.

## ✅ Solucionado

- **`trust proxy`** (#512): detrás de Nginx Proxy Manager `req.ip` era la IP del
  proxy para TODAS las peticiones → rate limiting global (5 logins/min para toda
  la plataforma, DoS trivial) y audit/security_events con una sola IP. Env
  `TRUST_PROXY_HOPS` (default 1).
- **SSRF con lectura en webhooks salientes** (#513): la URL la controla el tenant
  (alta libre) y el worker hacía `fetch` sin validar destino, siguiendo redirects
  y guardando 4 KB de la respuesta visibles en el panel → lectura de la red
  interna (Loki, Grafana, metadatos del VPS). `common/security/safe-http-post.ts`:
  IP validada en el `lookup` del socket (sin ventana de DNS rebinding), sin
  redirects, tope de respuesta; 400 `webhook_url_not_allowed` al guardar.
- **Web externa del tenant en el mismo origen que el portal** (#514): el HTML/JS
  proxificado podía leer la sesión del portal (localStorage) → datos, pagos y
  apertura de puertas. `Content-Security-Policy: sandbox` sin
  `allow-same-origin` en todas las respuestas de `/tenant-site`.
- **Secretos en logs y Sentry** (#516): `common/logging/sanitize.ts` sanea url,
  query y cabeceras (`x-device-key`, `x-camera-token`, `x-inbound-secret`, la
  device key + PIN de `GET /access/verify`, tokens de firma/NPS/invitación en la
  ruta) en pino, en el log de 5xx y en `beforeSend` de Sentry. ⚠️ Los logs ya
  almacenados en Loki conservan esos secretos: rotar device keys y tokens de
  cámaras o purgar la retención.
- **Next.js 15.5.18 → 15.5.26** (#517): 0 avisos críticos en `pnpm audit`.
- **Sesión expulsada al recargar** (#518): la detección paranoid de reuso del
  refresh revocaba TODAS las sesiones del usuario en carreras normales del
  navegador (recarga que aborta un refresh, varias pestañas; `AuthBootstrap`
  hacía su propio refresh sin deduplicar). Margen de gracia de 30 s (mismo
  user-agent, tope 3 hermanas) + bootstrap deduplicado. Era la causa del smoke
  01/02/03 intermitente.
- **Borradores de factura con número provisional no único** (#519):
  `DRAFT-<ms>` chocaba con `(tenant_id, invoice_number)` → 409 engañoso y
  facturas recurrentes saltadas en silencio. Sufijo aleatorio.
- **Cerraduras HTTP/Dahua seguían redirects** (#520): `redirect: 'manual'`.
- **Sesiones del portal no revocables** (#521): `customers.portal_session_version`
  en el JWT (`sv`), comprobada en cada request; se incrementa al restablecer o
  desactivar la contraseña y con «Cerrar sesiones del portal» (staff).
- **Bloqueo del teclado = puerta inutilizable para todos** (#522, decisión de
  Jota): la apertura desde el portal ya no consulta el bloqueo del teclado;
  aviso in-app al staff al bloquearse; PIN nuevos de 6-8 dígitos (los antiguos
  siguen valiendo). De paso: las operaciones automáticas sobre credenciales
  (emisión, suspensión por impago, reactivación, pase nocturno, acceso extra)
  no quedaban auditadas (`userId: 'system'` no es UUID) → `null`.
- **Email entrante suplantable** (#523, decisión de Jota: aceptar con aviso):
  sin DMARC `pass` del proveedor el mensaje entra marcado «remitente no
  verificado» (`customer_messages.sender_verified`). El proveedor debe reenviar
  el veredicto (`dmarc` o `Authentication-Results`).

- **Enumeración de cuentas por tiempo** (#525): argon2 ficticio en las ramas
  «no existe» de los logins de staff y super admin; «olvidé la contraseña»,
  «reenviar verificación» y enlaces del portal responden YA y envían en segundo
  plano (`respondThenRun`); el super admin desactivado ya no se revela antes de
  comprobar la contraseña.
- **Rol del super admin desde la BD** (#525): degradar surte efecto en la
  siguiente petición (antes, al caducar el JWT de 8 h).
- **2FA** (#526): tope de 5 fallos/15 min por usuario (tenant y super admin,
  429 `too_many_2fa_attempts`) + anti-replay TOTP (`two_factor_last_step`).
- **Rol restringido sin acceso a tablas globales** (#527): `REVOKE ALL` a
  `storageos_app` sobre 26 tablas de plataforma sin RLS (salvo
  `subscription_plans`/`subscription_addons`). ⚠️ Toda tabla global NUEVA debe
  llevar su propio REVOKE (los default privileges se lo conceden).
- **Tamaño máximo de subidas** (#528): 20 MB validados al registrar
  (`file_too_large`) + borrado de los objetos rechazados.

- **Herramientas del asistente IA sin permisos ni alcance por local**
  (2026-09-28, encontrado al revisar el asistente): las herramientas solo
  recibían el `tenantId`, así que un usuario limitado a un local veía por el
  asistente la ocupación, las facturas vencidas y la deuda de TODOS los locales.
  Ahora cada herramienta exige el permiso de su endpoint equivalente (solo se
  ofrecen al modelo las permitidas, y se revalida al ejecutarlas) y filtra por
  `facilityScope` con el mismo criterio que el panel.

## ⚖️ Riesgos aceptados (decisión de Jota)

- **CSP con `'unsafe-inline'` en `script-src`**: quitarlo en Next.js exige
  nonces, que fuerzan el renderizado dinámico de todas las páginas (se pierde la
  caché estática y la web pública va más lenta). Revisar si aparece HTML
  enriquecido de usuario.
- **Ventana de DNS rebinding en cerraduras/Dahua** entre `isSafeOutboundUrl` y
  el `fetch`: riesgo residual bajo (IP validada, sin redirects #520, exige ser
  admin del tenant). Se cerraría fijando la IP resuelta como `safe-http-post.ts`.
- **Contraseña fija de `storageos_app` en la migración de la fase 1A**: no se
  aplica en producción (DEPLOYMENT §6.5 crea el rol antes con
  `POSTGRES_APP_PASSWORD`); verificar una vez en el VPS.

## Otros

- Suite e2e `webhooks`: el test «retry manual» falla en local (attempts 2 vs 1);
  en CI pasa.

## Nota de test local

La suite e2e `webhooks` es inestable en local si hay un `nest start --watch`
compartiendo Redis (se lleva los jobs de la cola) o jobs retrasados de
ejecuciones previas; usar `REDIS_DB=<n>` con la DB vacía. En CI pasa.

---

# Auditoría de facturación (2026-10-02)

Revisión en profundidad, pedida por Jota, de que ninguna factura se contabilice dos veces y de que no haya errores: facturas, numeración, Veri\*Factu, Holded, cobros (Stripe, GoCardless, Redsys, SEPA, N43, manual), reembolsos, facturas de suscripción, informes fiscales y métricas. Plan de 8 PRs.

**Decisiones de Jota:** Veri\*Factu aún no está en producción (la PR 5 va antes de activarlo); la **fianza sale de la factura** y se cobra aparte; **anular una factura emitida** creará una rectificativa de abono automática.

## Graves (dinero o duplicados reales)

1. **Holded: facturas y cobros duplicados.** `pushDocument`/`pushPayments` comprueban, crean en Holded y guardan sin bloqueo; el aviso al emitir + «Enviar pendientes», o los avisos de «emitida» y «pagada» casi a la vez, duplican. → ✅ PR 2.
2. **Reembolso doble de dinero real.** `refund` sin bloqueo ni clave de idempotencia. → ✅ PR 1.
3. **Doble cobro con remesas SEPA.** Las facturas de una remesa generada se pueden pagar por otra vía y el banco las cobra igual; al confirmar, el fallo solo queda en el log. → ✅ PR 3 (la confirmación ya no se puede ejecutar dos veces: ✅ PR 1).
4. **Cobros simultáneos mal sumados.** Cobro manual con lectura previa a la transacción; webhooks de cobro, reembolso y disputa con el estado comprobado fuera; fase final del cobro por pasarela que sobrescribe. → ✅ PR 1.
5. **Emitir dos veces la misma factura.** Hueco en la numeración, dos envíos a la AEAT y huella autorreferida. → ✅ PR 1.
6. **Anular una factura emitida** (también el proceso de reservas sin pagar) sin registro de anulación en la AEAT ni rectificativa; rompe la cadena. → ✅ PR 4 (rectificativa de abono automática; la cadena por emisor y el registro de anulación AEAT van en la PR 5).

## Bloqueantes antes de activar Veri\*Factu en producción (PR 5)

7. Huella con algoritmo simplificado, encadenada por serie (debe ser por emisor e incluir anulaciones) y con la fecha-hora de generación creada en cada envío. → ✅ PR 5 (las anulaciones son rectificativas desde la PR 4: no se usan registros de anulación).
8. Desglose de IVA en una sola línea con el tipo deducido (alquiler 21 % + fianza 0 % → «14 %», rechazo); recargo y fianza como operación sujeta. → ✅ PR 5.
9. Envíos duplicados: sin comprobar si ya se aceptó, «Reenviar» de aceptadas, duplicado = rechazo, envío en paralelo desordenado, sin subsanación. → ✅ PR 5.
10. Se puede emitir sin NIF del tenant (huella con «PENDIENTE»). → ✅ PR 5 (en envío real; en modo `stub` se sigue permitiendo).

## Medios

11. La fianza se factura como venta (base en libro de IVA, 303, A3, métricas y Holded). → ✅ PR 6 (justificante de fianza aparte).
12. Rectificativa por sustitución sin compensar la original (base duplicada); rectificativas sin límite. → ✅ PR 6 (2ª parte).
13. Reembolsar no genera abono (IVA declarado sobre dinero devuelto). → ✅ PR 6 (2ª parte).
14. Recurrente: contratos «en baja» facturados tras su fin; inicio a mitad de mes sin prorrateo (contratos del staff); un **prepago deja de renovarse** si el contrato tiene una factura sin periodo (`ORDER BY period_end DESC` pone los nulos primero). → ✅ PR 7.
15. `revertPayment` marca como fallidos todos los pagos de la factura. → ✅ PR 7.
16. GoCardless `late_failure_settled` no se trata. → ✅ PR 7.
17. Cobro por pasarela sobre factura ya pagada por otra vía: sin aviso. → ✅ PR 7.
18. Holded no recibe reembolsos ni devoluciones. → ✅ PR 2 (salen «para revisar»: Holded no permite quitar un cobro por API; el abono por reembolso llega con la PR 6).
19. Numeración de facturas de suscripción sin bloqueo (un cobro puede quedar sin factura). → ✅ PR 7.
20. Una factura solo puede ir en una remesa en toda su vida; no se puede cancelar una remesa. → ✅ PR 3.
21. Métricas: lo cobrado ignora entero un pago con reembolso parcial; lo facturado no descuenta reembolsos. → ✅ PR 6 (2ª parte).

## PR 7 — casos límite de la recurrente y de los cobros ✅

- **Recurrente** (hallazgo 14):
  - un contrato con fecha de baja no se factura más allá de ella; si la baja cae dentro del mes, el alquiler y el seguro se prorratean hasta ese día;
  - un alta a mitad de mes (contratos del staff) se factura prorrateada desde el alta, y un contrato que empieza después del mes no se factura aún;
  - el prepago busca su última factura entre las que tienen periodo (una factura suelta del contrato ya no corta la renovación).
  - De paso, la recurrente ya no pasa el id del inquilino como «usuario» (rompía el registro de auditoría).
- **Devolución** (hallazgo 15): `revertPayment` solo marca fallido el cobro devuelto (uno del mismo importe o los más recientes que quepan), no todos los de la factura.
- **GoCardless** (hallazgo 16): `late_failure_settled`, o un `failed` sobre un cobro ya confirmado, revierte el cobro como una devolución.
- **Cobro duplicado** (hallazgo 17): un cobro de Stripe/GoCardless confirmado sobre una factura ya pagada por otra vía emite `payment_overpaid` → aviso al equipo con el importe a devolver (Redsys ya avisaba).
- **Facturas de suscripción** (hallazgo 19): numeración con bloqueo por serie; facturar el mismo pago a la vez devuelve la factura existente.
- e2e `billing-edges` (6 casos).

## Menores (PR 8)

22. Fecha de emisión en UTC (00:30 del día 1 cae en el mes/trimestre anterior); año del número por reloj del servidor; fecha anterior a la última de la serie permitida. → ✅ PR 8.
23. Reglas de precio (sin forma de crearlas hoy) alterarían la cuota congelada de los contratos. → ✅ PR 8.
24. N43: un apunte que paga dos facturas no se puede repartir. → ✅ PR 8.
25. F2 sin cliente cobrada a mano no crea pago (no cuenta en lo cobrado ni en la caja). → ✅ PR 8.

## PR 8 — menores ✅

- **Fecha de emisión** (hallazgo 22): hoy en la zona horaria del tenant (`todayInTimezone`, `common/format.ts`), no en UTC; el año del número sale de esa fecha; emitir con fecha anterior a la última factura de la serie → 400 `issue_date_before_last`.
- **Recurrente con precio congelado** (hallazgo 23): ya no pasa por las reglas de precio (son para contratos nuevos); para subir la cuota está la revisión de precios.
- **N43 repartido** (hallazgo 24): `POST /bank-statements/transactions/:id/match {invoiceIds: [...]}` reparte el ingreso por orden, a cada factura como mucho su pendiente; botón «Repartir…» con diálogo de selección en la conciliación.
- **F2 sin cliente** (hallazgo 25): `payments.customer_id` opcional (migración `20261005200000_payment_customer_optional`); el cobro manual crea su pago → cuenta en lo cobrado y en el cierre de caja.
- e2e `billing-minor` (3 casos).

## Holded de la plataforma — sin duplicados y con rectificativas ✅ (2026-10-03)

- **Reserva** antes de llamar a Holded (`platform_invoices.holded_sync_state` null|`creating`|`approving`, `credit_creating`/`credit_approving` para la anulación de una sustituida; `holded_sync_started_at`); el id se guarda antes de aprobar; el cobro se reserva aparte (`holded_payment_started_at`/`holded_payment_synced_at`). Holded rechaza → se libera; sin respuesta → «para revisar» a los 5 min. Migración `20261006100000_platform_holded_claims`.
- **Rectificativas**: por diferencias → rectificativa de Holded en la serie de rectificativas elegida (`platform_billing_settings.holded_credit_note_series_id`, comprobada «No enviar a Verifactu»); por sustitución → rectificativa que anula la original en Holded + factura nueva con los datos corregidos, sin cobro (el dinero está en la original y el abono lo compensa; Holded no deja cancelar una factura cobrada). La original va antes que su rectificativa; una original sustituida que nunca llegó a Holded no se copia.
- `GET /admin/platform-billing/holded/review` + `POST …/review/:invoiceId {kind, action}`; `PlatformHoldedSettingsDto.creditNoteSeriesId`/`reviewCount`; la rectificación también dispara la copia. Tarjeta del panel: selector de la serie de rectificativas y bloque «Para revisar en Holded».
- e2e `platform-holded` (2 casos).

## Bien resuelto (verificado)

Números de factura no repetibles (índice único + bloqueo de la serie al reservar); bloqueo contra el doble cargo en el cobro por pasarela; webhooks de Stripe/GoCardless sin doble procesamiento por id de evento; Redsys idempotente; recurrente sin duplicados por solapamiento de periodo; primera factura de una reserva sin duplicar.

## PR 1 — bloqueos en todo lo que mueve dinero ✅

- `issue()`: bloquea la fila (`FOR UPDATE`) y vuelve a comprobar que sigue en borrador → 409 `invoice_already_issued`.
- `markPaidManually` y `revertPayment`: todo el cálculo dentro de la transacción sobre la fila bloqueada.
- `refund`: una sola transacción bloqueada (hasta 30 s, incluye la llamada a la pasarela) + clave de idempotencia hacia Stripe y GoCardless (`refund-<pago>-<céntimos acumulados>`).
- Webhooks: transiciones atómicas (`updateMany` condicionado al estado) en cobro y disputa; el reembolso calcula el delta con el pago bloqueado.
- Cobro por pasarela: la fase final suma con incremento y solo si la reserva sigue en `processing`.
- Confirmar remesa SEPA y conciliar/devolver un apunte N43: se reclaman de forma atómica antes de tocar facturas.
- e2e `billing-concurrency`: 7 operaciones lanzadas dos veces a la vez. **Sin el arreglo fallan las 7**; con él pasan.

## PR 2 — Holded sin duplicados ✅

- Reserva atómica antes de llamar a Holded (`invoices.holded_sync_state` + `holded_sync_started_at`, `payments.holded_sync_started_at`): varios envíos a la vez dan una sola factura, un solo cobro y un solo contacto.
- Crear y aprobar por separado: el id de Holded se guarda antes de aprobar; si la aprobación falla, el reintento solo aprueba.
- Holded rechaza (error HTTP) → se libera y se reintenta. Holded no responde (red, tiempo agotado) → la reserva se queda: no se reintenta sola (pudo crearse) y a los 5 minutos sale «para revisar».
- Cobros ya copiados que luego se reembolsan o devuelven → «para revisar» (`payments.holded_reviewed_at` al marcarlos revisados).
- `GET /settings/holded/review` + `POST /settings/holded/review/{invoices|payments}/:id` (reenviar / ya está en Holded / revisado) y bloque «Para revisar en Holded» en Ajustes → Facturación.
- e2e `holded-idempotent` (6 casos: simultáneos, aprobación fallida, rechazo, sin respuesta, enlace manual, reembolso).
- Copia en Holded de las facturas de suscripción: misma reserva y lista «para revisar», y ahora también sus rectificativas (2026-10-03, ver abajo).

## PR 3 — remesas SEPA ✅

- Estado por adeudo (`sepa_remittance_items.status`: pending · collected · failed · returned · cancelled + `failure_reason`); el único por factura pasa a parcial: una sola remesa viva por factura.
- Factura con un adeudo pendiente: `mark-paid`, cobro por pasarela, portal y Redsys → 409 `invoice_in_sepa_remittance`. El dinero que ya entró (N43, notificación Redsys, liquidación) se registra igual y, al confirmar, ese adeudo queda `failed` para devolverlo.
- Crear la remesa bloquea y vuelve a comprobar las facturas dentro de la transacción; no entran facturas con un cobro por pasarela en curso.
- Confirmar admite los adeudos rechazados por el banco (`rejectedItemIds`) e informa de los no cobrados; solo pasan a RCUR los mandatos con algún cobro.
- Cancelar una remesa sin confirmar (`POST /sepa/remittances/:id/cancel`).
- Devolución por N43 → adeudo `returned`, la factura se puede presentar otra vez; si era el primer cobro del mandato, vuelve a FRST.
- e2e `sepa-remittance-safety` (3 casos).

## PR 4 — anular una factura emitida ✅

- Estado nuevo `rectified` («anulada con rectificativa», migración `20261005140000`). Un borrador se sigue cancelando (`cancelled`); una emitida (issued/overdue) y sin cobros pasa a `rectified` y se emite en el acto una **rectificativa de abono por el total** (R4; R5 si la original es simplificada) con las mismas líneas en negativo.
- La original sigue contando en el libro de IVA, 303/347, ingresos y la cadena de Veri\*Factu; la rectificativa resta. Ya no se cobra ni se reclama.
- La rectificativa de una anulación queda **compensada** (pagada por su importe, sin vencimiento): no cuenta como pendiente ni la reclama el cobro de impagos. Ninguna factura de importe ≤ 0 pasa a vencida.
- Con cobros → 400 `invoice_has_payments` (reembolsar o rectificar); con un cobro en curso → 409; en una remesa sin confirmar → 409. Dos anulaciones a la vez emiten una sola rectificativa (reserva con la fila bloqueada).
- Lo usan también la caducidad de reservas sin pagar, la venta y el pase nocturno no cobrados. Holded recibe la rectificativa (no se cancela la original allí).
- `InvoiceDto.rectifiedBy` (enlace a la rectificativa desde la anulada); en la web «Anular» pide confirmación y la anulada enlaza a su rectificativa; la rectificativa compensada se muestra «Compensada».
- e2e `invoice-cancel-rectify` (4 casos).

## PR 5 — Veri\*Factu conforme ✅

- **Huella oficial** (`billing/verifactu-hash.ts`): `IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=DD-MM-AAAA&TipoFactura=…&CuotaTotal=…&ImporteTotal=…&Huella=<anterior>&FechaHoraHusoGenRegistro=…`, SHA-256 en mayúsculas. Comprobada con los ejemplos publicados por la AEAT.
- **Cadena por emisor**, no por serie: `invoices.chain_seq` + `previous_invoice_id` (migración `20261005160000`), con bloqueo por tenant al emitir. La **FechaHoraHusoGenRegistro** se fija al emitir (`aeat_record_timestamp`) y el XML usa la misma (antes se creaba en cada envío y no coincidía con la huella).
- **Desglose por tipo de IVA**: una `DetalleDesglose` por tipo; las líneas al 0 % (fianza, recargo por mora) como no sujetas (N1) sin tipo ni cuota. Antes un único «tipo deducido» (21 % + 0 % → 14 %).
- **Destinatario**: NIF español válido → `<NIF>`; extranjero → `<IDOtro>` con país (pasaporte 03, documento extranjero 04).
- **NIF obligatorio en envío real** (`AEAT_MODE` ≠ stub): sin NIF válido del emisor → 400 `tenant_tax_id_required`; factura completa sin NIF/NIE válido del cliente (español) → 400 `customer_tax_id_required`.
- **Sin envíos duplicados**: no se envía lo ya aceptado; «Reenviar» de una aceptada → 400 `already_accepted`; si hubo un envío previo, se consulta a la AEAT antes de reenviar; «registro duplicado» (3000) → se consulta y se guarda el estado real.
- **En orden**: la cola procesa de uno en uno y un registro espera a que el anterior de la cadena esté resuelto (`previous_record_pending`); el cron cada 15 min reencola lo que agotó sus reintentos por un fallo pasajero.
- **QR**: URL de cotejo de producción o de pruebas según el modo y fecha DD-MM-AAAA.
- Los specs del XML y del cliente real vivían en `test/*.spec.ts` y no los ejecutaba ninguna configuración: movidos a `__tests__` (corren en CI). e2e `verifactu-chain` (3 casos).
- **Antes de activar producción**: las facturas emitidas hasta ahora llevan la huella antigua y no tienen posición en la cadena (nunca se registraron en la AEAT); la primera factura nueva de cada tenant empieza la cadena (`PrimerRegistro`).

## PR 6 — la fianza, en un justificante aparte ✅

- La fianza ya no es una línea de la factura: va en un **justificante de fianza** (`invoices.kind = 'deposit_receipt'`, número `FZ-<contrato>` fuera de la numeración fiscal, sin IVA, sin huella ni Veri\*Factu). Migración `20261005180000_deposit_receipts`.
- Fuera del libro de IVA, 303/347, exportación A3/Sage y de la asesoría, Holded, ingresos facturados y cobrados (analytics, P&L, asistente IA, panel admin).
- **Un solo pago** (decisión de Jota): el justificante queda enlazado a la 1ª factura (`bundled_with_invoice_id`); cobrar la factura con tarjeta/adeudo (portal, firma, cobro automático) carga el total en una sola operación y registra un pago en cada documento con el mismo id de pasarela; los webhooks (cobro, reembolso repartido factura → fianza, disputa) tratan el grupo; Redsys cobra el total y reparte al confirmar.
- **Acceso** al quedar pagados los dos documentos (antes, al pagar la factura). Un solo aviso «pago recibido» por el total.
- El justificante no lleva recargo, no se rectifica ni se reembolsa por pasarela (la fianza se devuelve al liquidarla); anularlo sin cobros lo cancela sin rectificativa.
- Portal: «Justificante de fianza», «se paga junto a la factura …» y «pagas … en total»; panel: distintivo «Fianza».
- e2e `booking-deposit` reescrito (3 casos: justificante y exclusiones; un pago Redsys → los dos pagados + un acceso; pago por separado → acceso solo al final).

## PR 6 (2ª parte) — rectificativas netas, abono al reembolsar y métricas ✅

- **Abono por reembolso** (hallazgo 13): cada devolución, hecha desde la app o desde la pasarela (webhook `charge.refunded`), emite el evento `invoice_refunded` → rectificativa R4/R5 por diferencias por lo devuelto, repartida por tipo de IVA en proporción a la factura, emitida y compensada (`paid`). Los justificantes de fianza no generan abono.
- **Límites** (hallazgo 12), comprobados al crear la rectificativa y otra vez al emitirla con la original bloqueada:
  - por diferencias: original + Σ diferencias ≥ 0 (400 `rectification_exceeds_original`);
  - por sustitución: solo sobre una factura sin cobros (400 `substitution_original_paid`) y sin otras rectificativas (409 `rectification_already_exists`); una factura sustituida no se rectifica por diferencias (409 `invoice_substituted`).
- **Sustitución sin base duplicada:** al emitir la sustitutiva, la original pasa a `rectified` (deja de cobrarse y vencer) y su copia en Holded se anula. En libro de IVA, 303, 347, exportación A3/Sage y de la asesoría, la sustitutiva cuenta solo la diferencia con la sustituida.
- **Métricas** (hallazgo 21): lo cobrado es neto de reembolsos (`amount − refundedAmount`, incluidos los pagos parcial o totalmente reembolsados) en analytics, P&L, asistente IA y panel admin; lo facturado descuenta lo devuelto a través de los abonos.
- e2e `invoice-rectify-refund` (2 casos).

# Segunda auditoría de facturación (2026-10-03)

Revisión completa de la facturación de la plataforma (suscripciones) y de los tenants (inquilinos), con Veri\*Factu, Holded y la exportación para la asesoría.

**Decisiones de Jota:**

- Cada tenant elige **dónde se emiten sus facturas**: en la app con Veri\*Factu (con **su propio certificado**) o en Holded (Holded numera y registra). La elección no se puede cambiar durante el año natural (salvo si aún no ha emitido ninguna ese año). La exportación para la asesoría está siempre disponible (no sustituye a Veri\*Factu: la obligación es de quien emite).
- La plataforma tiene la misma elección para las facturas de suscripción (Veri\*Factu con el certificado de TrasterOS SL, o Holded).
- El cobro con tarjeta de los tenants por la cuenta de Stripe de la plataforma se **desactiva** por ahora (Redsys, Bizum y GoCardless son de cada tenant); Stripe Connect más adelante.
- Los precios de suscripción se podrán configurar **con IVA incluido o +IVA**.

## Hallazgos

1. Facturas de suscripción sin Veri\*Factu (ni huella, ni QR, ni envío; la copia en Holded va a una serie «No enviar a Verifactu»). → PR 3.
2. Cobros con tarjeta de los inquilinos en la cuenta de Stripe de la plataforma (sin Connect). → PR aparte (desactivar).
3. Rectificativas de los tenants en la misma serie que las facturas (RD 1619/2012, art. 6 exige serie propia). → ✅ PR 1.
4. Redondeo asimétrico (`Math.round` en negativos) y en coma flotante: una anulación no dejaba la factura a cero. → ✅ PR 1.
5. Un abono manual no compensaba el pendiente de la original; las rectificativas negativas emitidas a mano entraban en el cobro de impagos. → ✅ PR 1.
6. Reembolsar tras un abono manual generaba un segundo abono; el reembolso se limitaba al total de la factura, no al dinero cobrado. → ✅ PR 1.
7. Reembolsos y contracargos de Stripe de las suscripciones y devoluciones de la remesa SEPA de la plataforma no se reflejan (ni abono). → PR 4.
8. XML con `IndicadorMultiplesOT = N` (la instalación factura por muchos tenants); en envío real se podía emitir sin certificado. → ✅ PR 1.
9. La exportación del tenant para su asesoría es solo CSV, sin cobros ni fianzas ni avisos de datos fiscales. → PR 5.

## PR 1 — correcciones ✅

- **Serie de rectificativas** (`invoice_series.is_rectification`, migración `20261006120000_rectification_series_credit_compensation`): `InvoiceSeriesService.rectificationSeries` la crea sola la primera vez (prefijo libre: `R`, `RECT`…); toda rectificativa va ahí; no puede ser la serie por defecto (409 `rectification_series_not_default`).
- **Redondeo**: `money.ts` → `roundHalfAway` (simétrico, con margen para la coma flotante) y `lineCents` (base redondeada, cuota sobre la base, total = base + cuota); `toCents` simétrico.
- **Abonos**: una rectificativa de importe negativo queda saldada al emitirse (sin vencimiento: no entra en impagos; el cron de impagos también filtra `total > 0`). Si es por diferencias y la original tiene pendiente, lo **compensa** con un pago `credit_note` (valor nuevo del enum; no es dinero cobrado: fuera de lo cobrado, la caja, los reembolsos, la copia en Holded y la exportación de cobros). Si la original queda saldada, `invoice_paid` con `compensated: true` (sin correo de «pago recibido»).
- **Reembolsos**: como mucho el dinero cobrado (sin compensaciones) → 400 `over_refund`; el abono automático por reembolso se calcula sobre lo devuelto en total menos lo que ya cubren los abonos emitidos (sin abono doble).
- **Veri\*Factu**: `IndicadorMultiplesOT = S`; en envío real, emitir sin certificado vigente → 400 `aeat_certificate_required`.
- e2e `billing-audit2` (3 casos).

## PR aparte — cobro con tarjeta de los inquilinos desactivado ✅

Hallazgo 2. Variable nueva `TENANT_CARD_PAYMENTS_ENABLED` (por defecto `false`): sin Stripe Connect, la cuenta de Stripe es la de la plataforma y el dinero de los inquilinos acabaría en TrasterOS. Con ella apagada, registrar tarjeta/IBAN por Stripe (staff y portal) y cobrar con un método de Stripe dan 400 `card_payments_disabled`; `GET /payment-methods/options` y `GET /portal/me/payments/options` → `{cardPayments}` para que la web oculte los formularios (ficha del inquilino, portal y página de firma de la reserva online). Los cobros por Redsys/Bizum, GoCardless y remesa SEPA no cambian; Stripe sigue sirviendo para la suscripción. e2e `tenant-card-payments`.

## PR 2 — dónde se emiten las facturas del tenant ✅

- `tenants.invoicing_mode` (`app` | `holded`, por defecto `app`) + `invoicing_mode_pending`/`invoicing_mode_pending_from`; `invoices.issued_by`; `holded_settings.issuing_invoice_series_id`/`issuing_credit_note_series_id` (migración `20261006140000_tenant_invoicing_mode`).
- **Regla del año**: si el tenant ya emitió facturas este año natural, el cambio queda programado para el 1 de enero (`InvoicingModeService.current` lo aplica al llegar la fecha, sin cron); si no, es inmediato. Elegir otra vez el modo actual anula el cambio programado.
- **Modo `holded`**: `issue()` reserva la factura (`holdedSyncState = 'creating'`), la crea en la serie de emisión de Holded (que **sí** va a Veri\*Factu; 400 `holded_series_excluded` si está excluida), la aprueba y lee su número (`document_number`); la guarda con ese número, `issued_by = 'holded'`, sin huella ni envío propio a la AEAT. Reanuda sin duplicar si falló a mitad (`approving` → aprobar, `numbering` → leer el número); si Holded no respondió al crearla, queda reservada (409 `invoice_issue_in_progress`) y sale «para revisar». El PDF es el de Holded (`GET /invoices/{id}/pdf`, binario). Los cobros se anotan en esa factura de Holded. No hay sustitutivas en este modo (400 `holded_substitution_not_supported`); reenviar a la AEAT desde la app → 400 `issued_by_holded`.
- **Rectificativas en modo Holded (decisión de Jota)**: la API v2 de Holded no permite indicar qué factura rectifica, así que la app no las crea allí. Una anulación o un abono queda en borrador «pendiente de hacer en Holded» (`holdedSyncState = 'awaiting_holded'`, sale en «Para revisar» como `credit_note_pending` con el número de la original); el tenant la crea en Holded desde la factura original y la enlaza con `POST /invoices/:id/link-holded {holdedDocumentId}` → se emite aquí con el número de Holded y compensa la original. La original anulada deja de cobrarse desde el primer momento.
- `BillingModule` importa `AccountingModule`: los avisos de Holded (emitida, cobrada) se procesan también en el worker.
- e2e `invoicing-mode`.

## PR 3a — precios de la plataforma con IVA incluido o +IVA + NIF único ✅

- `platform_billing_settings.prices_include_vat` (true por defecto) + `stripe_tax_rate_id`/`stripe_tax_rate_percent` (migración `20261006160000_platform_prices_vat`). Con «+ IVA» se cobra el precio más el IVA (`platform-pricing.ts`: `platformPricing`/`amountToCharge`) en la remesa SEPA de la plataforma, el cobro manual de extras desde «Hoy» y las suscripciones nuevas por Stripe (`default_tax_rates` con un TaxRate de Stripe que se crea la primera vez y otra vez si cambia el tipo). Las suscripciones de Stripe ya existentes conservan su importe. El desglose de una factura de Stripe con IVA aparte escala cada línea al total cobrado. `TenantBillingSummaryDto.pricesIncludeVat`/`effectiveMonthlyToCharge`; el catálogo público de planes lleva `pricesIncludeVat`; la web muestra «IVA incl.» o «+ IVA».
- **NIF único**: un NIF solo puede pertenecer a una empresa activa (Veri\*Factu encadena por emisor) → `common/tax-id-unique.ts` (`assertTaxIdFree`) en los datos de facturación del tenant y en la edición desde el admin; 409 `tax_id_in_use`.
- e2e `platform-prices-vat` (2 casos).
- **Decisión de Jota para la PR 3c**: las facturas de suscripción se emitirán como facturas del tenant propio de TrasterOS SL (el «Negocio propio» de los ajustes), con cada tenant como su cliente → misma cadena Veri\*Factu, mismo modo de emisión (app/Holded) y misma exportación.

## PR 3c — las facturas de suscripción las emite el negocio propio ✅

Hallazgo 1 (decisión de Jota, opción a). Con el «negocio propio» configurado en Facturación SaaS (el tenant de la sociedad emisora, con el mismo NIF: 400 `own_tenant_tax_id_mismatch` si no coincide), cada cobro de suscripción se factura como una **factura normal de ese tenant** (`PlatformOwnTenantInvoicingService`):

- el tenant cobrado es un cliente del negocio propio (`customers.platform_tenant_id`), creado y actualizado con sus datos de facturación;
- la factura (`invoices.platform_payment_id`, idempotente con reserva `tenant_subscription_payments.invoicing_claimed_at`) se emite en su serie, con su cadena Veri\*Factu o en Holded según el modo de emisión del negocio propio, y se marca cobrada con la forma de pago del cobro;
- `platform_invoices` guarda la copia que ven el tenant y el admin (`invoice_id`, número de la factura real, su PDF; `PlatformInvoiceDto.ownTenantInvoiceId`);
- se rectifican desde el negocio propio (desde la plataforma → 400 `rectify_in_own_tenant`) y la rectificativa se copia sola (`onOwnTenantInvoiceIssued`);
- sin los correos de inquilino ni las automatizaciones del negocio propio para estas facturas (llevan el correo de la plataforma); la copia contable de Holded de la plataforma y la exportación para la asesoría no las duplican.
- Sin negocio propio se mantiene la numeración propia antigua solo en pruebas: con envío real a la AEAT → 400 `own_tenant_required`.
- Migración `20261006180000_platform_invoices_own_tenant` (el único de `platform_invoices (series, number)` pasa a parcial `WHERE series <> 'own'`). e2e `platform-own-tenant`.

## PR 4 — reembolsos, contracargos y devoluciones de las suscripciones ✅

Hallazgo 7. Antes un reembolso o contracargo de Stripe de una suscripción, o una devolución de la remesa SEPA de la plataforma, no se reflejaba en el pago ni abonaba la factura.

- `tenant_subscription_payments.refunded_amount`/`refunded_at`/`disputed_at`/`dispute_reason` + `platform_sepa_remittance_items.payment_id` (migración `20261006200000_saas_payment_reversals`).
- El webhook de Stripe identifica un cobro de suscripción por `invoicePayments.list` (con la API `2026-04-22.dahlia` el cobro no trae la factura): `charge.refunded` → `syncSubscriptionRefund` (por diferencia sobre el total devuelto acumulado, transición condicionada: reenviar el aviso no abona dos veces); `charge.dispute.created` → `markSubscriptionDisputed` (aviso al super admin, aún sin abono); `charge.dispute.closed` perdido → abono por el importe disputado + suscripción `past_due` (ganado → se limpia).
- Remesa SEPA de la plataforma: al confirmar guarda el pago de cada adeudo; marcar uno como devuelto abona su factura (además del `past_due` que ya hacía).
- El abono: con negocio propio, reembolso de su factura (`InvoicesService.refund`, `userId` null) → rectificativa automática → copia en la suscripción del tenant; sin él, rectificativa por diferencias de la numeración propia (`PlatformInvoicesService.creditForPayment`).
- `TenantSubscriptionPaymentDto.refundedAmount`/`disputed`; la web muestra «Devuelto», «Devuelto en parte» y «contracargo».
- e2e `saas-payment-reversals` (reembolso parcial, aviso repetido sin abono doble, resto, contracargo perdido). El camino de Stripe (`invoicePayments`) no se ejercita en test (sin Stripe en CI).
