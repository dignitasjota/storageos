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
