# 048. Cierre de TODOs y operabilidad (Fase 15)

- Fecha: 2026-05-21
- Estado: aceptada
- Fase: 15 (cierre de TODOs y operabilidad)
- Amplía: ADR-043 (Veri\*Factu real client con mTLS), ADR-047 (Hardening final pre-deploy)

## Contexto

Tras cerrar Fase 14 (flag `ENABLE_WORKERS_IN_API` + tests del worker con `ioredis-mock` + API keys revealed-once + webhooks salientes con HMAC SHA-256) quedaron tres TODOs operativos anotados que bloqueaban el despliegue al primer cliente real. No son features de negocio nuevas — son piezas de operabilidad que el primer cliente nos exigirá al onboardear:

1. **Invoices `aeat_status='pending'` huérfanas sin polling**. Fase 10A (`RealAeatClient`) implementó `sendInvoice` con mTLS, pero el flujo asíncrono de AEAT exige consultar el estado después: si AEAT acusa recibo pero deja la factura en `pending` (por carga de su sistema o porque la respuesta SOAP llegó truncada), el `aeat_status` se queda anclado en `pending` para siempre. Sin un cron de polling, el operador no sabe si la factura está aceptada por AEAT o sigue en proceso. La factura ya está emitida con hash + número irrevocable; sólo falta confirmar el sello AEAT.
2. **Webhooks fallidos sin retry manual desde UI**. Fase 14A.3 dejó `webhook_deliveries` con retry 3× exponencial automático en BullMQ; tras 3 attempts queda `status='failed'`. Si el endpoint del consumer estaba caído durante la ventana de retry (40 min total con backoff de 60s) y luego recupera, no había forma de re-disparar el webhook desde el panel del tenant. El cliente tiene que llamarnos pidiendo "reenviad este `invoice.paid` que perdí".
3. **API keys con scopes informativos, no enforced**. Fase 14A.3 persistió el campo `scopes JSONB` pero no había decorador para enforcearlo: cualquier API key activa podía llamar cualquier endpoint `/v1/integrations/*` (cuando los haya). Al diseñar el primer endpoint público apareció el requisito mínimo de scopes (`invoices:read` vs `invoices:write` vs `webhooks:trigger`) para que el operador pueda emitir keys de sólo lectura a un Zapier sin abrir toda la API.

## Decisión

Se cierran en 4 sub-bloques (15A.1 a 15A.4) sin tocar funcionalidad de negocio existente. Sólo se añade el cron de polling AEAT + endpoint manual, el retry manual de webhooks + dashboard de deliveries con paginación y filtros, el enforcement de scopes con decorador, y este ADR.

### 1. AEAT `getStatus` polling + endpoint manual (15A.1)

`RealAeatClient.getStatus(args)` implementado con XML SOAP `ConsultaFactuSistemaFacturacion` (no `ConsultaLR` — AEAT espera filtro por NIF emisor + número de factura + fecha de expedición, no por CSV ni por hash). `VerifactuXmlBuilder.buildConsultaFactu(args)` construye el envelope con `Cabecera/ObligadoEmision` (NIF emisor) + `FiltroConsulta/PeriodoImpositivo + IDFactura/NumSerieFactura/FechaExpedicionFactura`. Parseo SOAP con regex tolerante a namespaces, idéntico al de `sendInvoice` (campos `<EstadoRegistro>`, `<CSV>`, `<CodigoErrorRegistro>`, `<DescripcionErrorRegistro>`).

`VerifactuService.refreshStatus(invoiceId, tenantId)`:

1. Carga la invoice con `aeat_status='pending'` y `aeat_sent_at IS NOT NULL`.
2. Llama `RealAeatClient.getStatus({ nif, numSerie, fechaExpedicion })`.
3. Actualiza `aeat_status`, `aeat_csv`, `aeat_response` (raw XML).
4. Si pasa a `accepted` o `rejected`, el polling para esa factura termina.

`VerifactuStatusPollerCron` con `@Cron('*/15 * * * *')` (configurable en el futuro vía env si crece el volumen): busca invoices con `aeat_status='pending'` y `aeat_sent_at < now() - 5min` (skip las recién enviadas para dar tiempo al ack inicial), hasta 50 en batch (`take: 50`) ordenadas por `aeat_sent_at ASC`. Para cada una llama `refreshStatus`. Sin reintento adicional dentro del cron: si `getStatus` falla, vuelve al siguiente tick. **Importante**: el cron también se condiciona al spread `WORKERS_ENABLED_IN_API` (Fase 14A.1) — en producción corre en el worker, no en el API.

Endpoint `POST /v1/billing/invoices/:id/refresh-aeat-status` (role `owner|manager`): permite al operador forzar la consulta desde la UI sin esperar al tick del cron. UI: nuevo botón "Consultar AEAT" en `<VerifactuBadge>` visible cuando el status es `pending` o `error`. Tras el click, refresca el query y muestra el nuevo status sin recargar la página.

### 2. Webhooks dashboard + retry manual (15A.2)

`WebhooksService.retryDelivery(args)` resetea el delivery **antes** de encolar (`attempts=0`, `status='pending'`, `error_message=null`) en una sola sentencia; el orden importa porque si encolas primero y luego reseteas, el worker puede leer el delivery con `attempts=3` y dropearlo antes de que el reset se aplique. Validaciones: `delivery_not_found` si no existe, `delivery_not_retryable` si el estado actual no es `failed` (no se permite reencolar deliveries `delivered` o `pending`).

Endpoint `POST /v1/settings/webhooks/:webhookId/deliveries/:deliveryId/retry` (role `owner|manager`). Devuelve `{ delivery: { id, status, attempts, ... } }`.

Página `/settings/webhooks/[id]` nueva con:

- Tabla de deliveries paginada cursor (no offset — `webhook_deliveries` puede crecer mucho, los offsets se vuelven lentos).
- Filtros: `status` (`pending|delivered|failed`), `fromDate`, `toDate`.
- Dialog detalle por delivery con: `payload` JSON formateado, `signature` header, `httpStatus`, `responseBody`, `errorMessage`.
- Botón "Reintentar" sólo visible cuando `status='failed'` (cualquier otro estado no es retryable).

Esto sustituye el "tabla últimos 50 deliveries con expand" de Fase 14A.3 (que era una vista colapsada dentro de `/settings/integrations` tab webhooks). Ahora ese tab tiene un botón "Ver deliveries" por webhook que lleva a `/settings/webhooks/[id]`.

### 3. API keys scopes enforced (15A.3)

Lista whitelist de **5 scopes** en `packages/shared/src/integrations/api-keys.schema.ts`:

```ts
export const API_KEY_SCOPES = [
  'invoices:read',
  'invoices:write',
  'contracts:read',
  'customers:read',
  'webhooks:trigger',
] as const;
```

Decorador `@RequireScope(scope: string)` en `apps/api/src/modules/api-keys/decorators/require-scope.decorator.ts` con metadata key `REQUIRE_SCOPE_KEY`. Se aplica a método (no a clase) porque cada endpoint público necesita declarar su scope concreto.

`ApiKeyGuard` lee el metadato vía `Reflector.getAllAndOverride(REQUIRE_SCOPE_KEY, [handler, class])`. Si el endpoint declara un scope y la API key no lo tiene en `scopes` (y no tiene wildcard `'*'`), lanza `ForbiddenException` con `code: 'insufficient_scope'` + `details: { requiredScope }`. Nota: `HttpExceptionFilter` propaga `code` + `details` al body de respuesta — `details` se usa para devolver el scope que falta, NO como propiedad top-level custom (eso no se propaga).

`ApiKeysService.create` normaliza `scopes`:

- Array vacío `[]` → `['*']` (wildcard backwards-compat con keys de Fase 14A.3).
- Si el array contiene los 5 scopes públicos completos → `['*']` (atajo para "todo permitido").
- Si contiene un scope desconocido (no en la whitelist) → `BadRequestException` con `code: 'invalid_scope'` + `details: { invalidScope }`.

Endpoint `GET /v1/integrations/whoami` (el primero público) con `@RequireScope('invoices:read')` como ejemplo y para que el primer integrador real tenga algo contra qué probar.

UI: multiselect de scopes en el dialog "Nueva API key" (checkboxes con las 5 opciones + label). Default sin selección = wildcard `*` con un hint visual "(sin selección = acceso total)".

### 4. ADR-048 + actualización docs (15A.4)

Este ADR + actualización de `docs/ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Alternativas rechazadas

- **Webhook (HTTP callback) desde AEAT** en lugar de polling: AEAT no expone webhook saliente para Veri\*Factu. La única forma de consultar el estado post-`sendInvoice` es `ConsultaFactuSistemaFacturacion`. Polling es la única opción.
- **Retry automático infinito para webhooks fallidos** vs retry manual: infinito enmascara endpoints permanentemente caídos (el cliente cambió la URL y no nos avisa) y consume cola sin tope. 3× automático + manual desde UI es el balance: la mayoría de fallos transitorios se recuperan en los 3 intentos; los permanentes los retoma el operador cuando el consumer recupera.
- **Scopes finos por recurso+acción** (`invoices:create`, `invoices:list`, `invoices:get-by-id`, `invoices:update`, ...) vs broad scopes (5 totales): broad cubre 95% de los casos sin sobre-engineering. Diseñar 30+ scopes ahora sería diseño especulativo sin feedback del primer integrador. Si llega el caso de "quiero crear pero no listar", se añade `invoices:create` separado.
- **Scope inferido del endpoint** (decorador implícito en el controller name) vs decorador explícito `@RequireScope(...)`: explícito es auditable (`grep -r RequireScope` muestra exactamente qué endpoints requieren qué scope) y permite endpoints con scopes especiales sin renombrar el controller. El coste es recordar añadirlo en cada nuevo endpoint público; el beneficio es claridad.
- **Resetear delivery después de encolar** vs antes: si encolas primero, el worker puede leer el delivery con `attempts=3` y dropearlo antes de que el reset se aplique (race condition entre `UPDATE webhook_deliveries` y `add() → process()` de BullMQ). Resetear primero garantiza que cuando el worker procesa el job, ve `attempts=0, status='pending'`.
- **Poller AEAT con intervalo configurable vía env** (`AEAT_POLL_INTERVAL_MINUTES=15`): añade superficie de configuración para un valor que cambia rara vez. Hardcoded `*/15 * * * *` es razonable; si crece volumen, se hace env.
- **Dashboard de deliveries con offset pagination** vs cursor: `webhook_deliveries` puede crecer mucho (un tenant activo con webhooks a 3 consumers genera ~10k deliveries/mes); offsets se vuelven lentos. Cursor sigue el patrón del resto del API.

## Consecuencias

### AEAT polling (15A.1)

- **(+)** Las facturas `pending` huérfanas se reconcilian solas cada 15 min sin intervención del operador. El primer cliente no nos llama por "esta factura sigue en pending desde anteayer".
- **(+)** Botón "Consultar AEAT" desde la UI da al operador control inmediato sin esperar al tick: útil cuando una factura crítica del cliente está bloqueada.
- **(+)** Cron condicionado al flag `WORKERS_ENABLED_IN_API`: en producción corre en el worker (consistente con Fase 14A.1), no genera doble polling.
- **(−)** Polling consume requests SOAP a AEAT incluso cuando todas las facturas están `accepted`. Mitigación: el `WHERE aeat_status='pending'` filtra a cero rows cuando todo está reconciliado; el cron sólo paga el `SELECT`, no llama a AEAT.
- **(−)** `take: 50` puede ser corto si un día se acumulan 200 pending por un fallo AEAT prolongado. En ese caso, el cron tarda 4 ticks (1h) en limpiar el backlog. Aceptable para MVP; si crece, subir el batch.
- **(~)** AEAT no documenta SLA para el `getStatus` — si tardan >5s en responder, el cron puede saturarse. Sin observabilidad real todavía sobre tiempos AEAT; queda pendiente añadir métricas Prometheus.

### Webhooks dashboard + retry manual (15A.2)

- **(+)** El operador resuelve fallos transitorios sin pedirnos los logs. La página `/settings/webhooks/[id]` es self-service.
- **(+)** Cursor pagination escala a millones de deliveries sin penalización de query.
- **(+)** Filtros `status + fromDate + toDate` cubren los 3 ejes de búsqueda más comunes: "qué falló ayer", "qué falló esta semana", "qué falló hoy".
- **(−)** Sin cleanup cron, `webhook_deliveries` sigue creciendo sin tope. Documentado como backlog post-Fase 15.
- **(−)** El retry manual reencola en la misma cola BullMQ; si el sistema está saturado, el delivery puede tardar minutos en ejecutarse aunque el operador lo lanzó. UX: el botón debería mostrar "encolado" inmediatamente y refrescar la tabla cada 5s.
- **(~)** No hay rate limiting específico para el retry manual: un operador con dedos nerviosos puede dispararlo 10 veces en 1s. Aceptable (idempotente: cada retry reenvía el mismo body con el mismo HMAC).

### Scopes enforced (15A.3)

- **(+)** El operador puede emitir API keys de sólo lectura para un Zapier que sólo necesita listar invoices, sin abrir el resto de la API.
- **(+)** Decorador explícito `@RequireScope(...)` es auditable: `grep -r RequireScope apps/api/src` muestra todos los endpoints scoped.
- **(+)** Backwards compat: keys de Fase 14A.3 sin scopes funcionan via wildcard `*` (normalización transparente).
- **(+)** 5 scopes (broad) en lugar de 30+ (fine-grained) deja la API key UI simple: 5 checkboxes vs un wizard.
- **(−)** Granularidad media: "invoices:read" da acceso a todas las invoices del tenant. Si un cliente pide "solo facturas de tal serie", hay que diseñar scopes finos en Fase 16+.
- **(−)** Cada nuevo endpoint público `/v1/integrations/*` requiere recordar el `@RequireScope(...)` decorator. Sin él, el endpoint queda abierto a cualquier API key activa. Mitigación: linter custom o test e2e que verifique que todos los endpoints `/v1/integrations/*` tienen el decorador (backlog).
- **(~)** `HttpExceptionFilter` propaga `code` + `details` al body — el `details: { requiredScope }` se devuelve al consumer para que pueda mostrar mensaje claro ("falta scope `invoices:write`"). Esto **no** funciona con propiedad top-level custom; hay que usar `details`.

## Lecciones aprendidas

- **AEAT `ConsultaFactuSistemaFacturacion` espera filtro por NIF emisor + número de factura + fecha de expedición**, no por CSV ni por hash. El XSD oficial (ConsultaLR.xsd) define exactamente este filtro; intentar consultar por CSV devuelve fault SOAP.
- **`HttpExceptionFilter` solo propaga `code` + `details` al body de respuesta** — usar `details: { requiredScope }`, no propiedad top-level custom. Las propiedades extra en `new ForbiddenException({ ... })` que no estén en `{ message, code, details }` se pierden en la serialización.
- **Cron poller con `take: 50` en batch** evita escalada cuando hay pico de pending huérfanos (después de un outage AEAT prolongado). Sin tope, el cron podría hacer 5000 requests SOAP en un tick y tumbar el sistema.
- **Default scope `['*']` mantiene backwards compat** con keys de Fase 14A.3 sin tocar BD. La normalización en `ApiKeysService.create` traduce `[]` y "los 5 scopes" a `['*']`, así `ApiKeyGuard` sólo necesita verificar la presencia del wildcard o del scope concreto.
- **Re-encolar delivery requiere resetear `attempts=0, status='pending', error_message=null` ANTES de encolar** (orden importa por race con el worker). Si reseteas después, el worker puede leer el delivery con `attempts=3` y dropearlo antes del UPDATE.
- **Cursor pagination en `webhook_deliveries`** (no offset) porque la tabla puede crecer a 100k+ filas en un tenant activo. Offsets se vuelven lentos a partir de los 10k.
- **Decorador explícito `@RequireScope(scope)` con `Reflector.getAllAndOverride(...)`** es la forma idiomática en NestJS de implementar enforcement: el guard lee el metadato y compara contra el contexto del request (en este caso `request.apiKey.scopes`).

## Referencias

- **AEAT consultas Veri\*Factu**: spec ConsultaLR.xsd (sede.agenciatributaria.gob.es)
- **Stripe webhook retry UX**: <https://stripe.com/docs/webhooks#retries>
- **OAuth 2.0 scope conventions (RFC 6749 §3.3)**: <https://datatracker.ietf.org/doc/html/rfc6749#section-3.3>
- ADR-043 (Fase 10): Veri\*Factu real client con mTLS + cert por tenant.
- ADR-047 (Fase 14): Hardening final pre-deploy (flag workers, ioredis-mock, API keys, webhooks HMAC).
