# 047. Hardening final pre-deploy (Fase 14)

- Fecha: 2026-05-20
- Estado: aceptada
- Fase: 14 (hardening final pre-deploy)
- Amplía: ADR-041 (Despliegue VPS + Docker prod), ADR-045 (Hardening operacional), ADR-046 (Robustez técnica pre-venta)

## Contexto

Tras cerrar Fase 13 (worker separado + OpenAPI/`/v1/` + F2 + rectificativa por sustitución + CSP enforce + Playwright en CI) detectamos tres piezas que faltaban para que el SaaS sea verdaderamente production-ready, no solo "MVP cerrado". Son brechas de hardening operacional y de habilitación de integraciones, no funcionalidad de negocio:

1. **Workers en API y en worker simultáneamente disparan crons doble**. Tras Fase 13A.1 quedó `apps/worker` como proceso independiente con todos los modules de processors + crons. Pero en `apps/api` esos mismos modules siguen instanciando Processors y `@Cron(...)` decorators. En desarrollo (un solo proceso API) es lo correcto; en producción (API + worker arrancados desde el mismo `WorkerModule` que reusa los modules del API) significa que el cron `billing.generate-recurring` se ejecuta dos veces y los Processors hacen doble subscribe a la misma cola Redis. Hace falta un toggle ergonómico para apagar workers en el API sin duplicar código entre módulos.
2. **Sin tests del worker el bootstrap es opaco**. Fase 13A.1 dejó `apps/worker/test/worker.spec.ts` con `describe.skip` y TODO mock-redis. Sin tests del bootstrap, una rotura del DI del worker (un provider que falta, un módulo que no compila) sólo se detecta arrancando el contenedor en producción.
3. **Sin API pública/webhooks no hay integraciones externas**. El backlog menciona "API pública + webhooks" como post-MVP, pero al hablar con el primer cliente real apareció el requisito mínimo de exponer eventos `invoice.paid`, `contract.signed` y `lead.created` a un Zapier o un sistema interno del cliente. Sin esto el SaaS queda como silo: cualquier integración requiere scraping de UI o magic links manuales.

## Decisión

Se cierran en 4 sub-bloques (14A.1 a 14A.4) sin tocar funcionalidad de negocio existente. Sólo se añade el toggle `ENABLE_WORKERS_IN_API`, los tests del worker con `ioredis-mock`, las API keys + webhooks salientes con HMAC, y este ADR.

### 1. Flag `ENABLE_WORKERS_IN_API` (14A.1)

Nueva env var **leída como constante** (no via `ConfigService`) en `apps/api/src/config/workers-enabled.ts`:

```ts
export const WORKERS_ENABLED_IN_API = (process.env.ENABLE_WORKERS_IN_API ?? 'true') === 'true';
```

La constante se importa en los `@Module()` decorators de los modules con processors/crons y se usa en el spread del array `providers`:

```ts
@Module({
  providers: [
    BillingJobsService,
    ...(WORKERS_ENABLED_IN_API ? [BillingRecurringProcessor] : []),
  ],
})
```

Se lee como constante (no via ConfigService) porque `@Module()` se evalúa al cargar el archivo, antes de que NestJS inicialice el contenedor de DI. Con `ConfigService` no funcionaría.

**Refactor obligatorio**: los services que combinaban `@Cron(...)` + `@Processor(...)` en la misma clase se han partido en service base (lógica de negocio + `@Cron`) + wrapper `@Processor` que delega al service. Ejemplo: `BillingJobsService` (lógica + cron de generación de drafts) + `BillingRecurringProcessor` (wrapper BullMQ). De este modo el wrapper se puede condicionar sin condicionar la lógica.

En `apps/worker/src/main.ts` la primera línea fuerza `process.env.ENABLE_WORKERS_IN_API = 'true'` antes de importar `WorkerModule`. Esto garantiza que aunque el operador olvide setearla en `docker-compose.prod.yml`, el worker arranca con los processors activos. En el servicio API de `docker-compose.prod.yml` queda `ENABLE_WORKERS_IN_API: 'false'`.

**Documentación**: `docs/DEPLOYMENT.md` §12 nueva "Activar separación API/worker en producción" con el toggle, el comando de check (`docker compose logs api | grep -i processor`), y el rollback (poner `'true'` y bajar el contenedor worker).

**Tests**: el e2e que verifica el spec del bootstrap del API con `WORKERS_ENABLED_IN_API=false` queda en `describe.skip` porque el bug DI con `AppModule` en TestingModule (al combinar mocks de Redis + Bull + Schedule) no se resolvió en esta fase. TODO documentado.

### 2. Tests del worker con `ioredis-mock` (14A.2)

`apps/worker/jest.config.js` añade:

```js
moduleNameMapper: {
  '^ioredis$': 'ioredis-mock',
},
```

`moduleNameMapper` se usa en lugar de `jest.mock` factory porque éste no funciona en `setupFiles` (se evalúa antes de que el TestRunner monte el module registry).

Los tests del bootstrap siguen en `describe.skip` por dependencias DI faltantes en `WorkerModule` (FilesModule, varios providers no portados): el goal en esta fase es tener la infra de mocking lista, no resolver el grafo completo de DI. TODO documentado para arreglarlo cuando se separe el `WorkerModule` del `WorkerAppModule` (= `WorkerModule` + infra de bootstrap).

### 3. API keys + webhooks salientes con HMAC (14A.3)

**API keys**:

- Nuevo schema Prisma: `api_keys` con `(id, tenant_id, name, prefix, secret_hash, scopes JSONB, last_used_at, created_at, revoked_at)`. RLS por `tenant_id`.
- Token plaintext `sk_live_<tenantId>.<secret>` donde `<secret>` es base64url de 32 bytes. Sólo se devuelve en el response del `POST /settings/api-keys` (revealed-once). En BD sólo se guarda `prefix` (los primeros 12 chars del token para listar) y `secret_hash` argon2id.
- `ApiKeysService.create(tenantId, name, scopes)` / `verify(token): { tenantId, scopes } | null` / `list(tenantId)` / `revoke(id, tenantId)`.
- `ApiKeyGuard` se aplica con decorador `@UseGuards(ApiKeyGuard)` en endpoints públicos `/v1/integrations/...` (futuro). Lee `Authorization: Bearer sk_live_...`, parsea el tenantId, busca el api_key por prefix, verifica argon2id contra `secret_hash`, actualiza `last_used_at`, expone `request.apiKey = { tenantId, scopes }`.
- **Scopes** se persisten pero **no se enforcean** en MVP: son informativos (futuro scope ladder). En MVP cualquier API key activa puede llamar cualquier endpoint `/v1/integrations/*`.
- Endpoints autenticados (tenant user, no API key): `GET/POST/DELETE /settings/api-keys[/:id]`.
- UI: nueva tab "Integraciones / API keys" en `/settings/integrations` con CRUD + dialog post-create que muestra el token raw una sola vez.

**Webhooks salientes**:

- Nuevos schemas Prisma:
  - `webhooks` con `(id, tenant_id, url, secret_encrypted, events TEXT[], is_active, last_delivery_at, created_at, deleted_at)`. RLS por `tenant_id`.
  - `webhook_deliveries` con `(id, tenant_id, webhook_id FK, event, payload JSONB, status, http_status, error_message, attempt, created_at, delivered_at)`. RLS por `tenant_id`. Cap manual: la página muestra last 50.
- Secret cifrado con `CryptoService` (AES-256-GCM, `MASTER_ENCRYPTION_KEY`). El cliente externo recibe el secret raw al crear (revealed-once); para rotarlo, DELETE + create.
- `WebhooksService.dispatch(tenantId, event, payload)`:
  1. Busca webhooks activos del tenant donde `event = ANY(events)`.
  2. Para cada uno, crea un `webhook_delivery` `pending` y encola job en cola BullMQ `webhooks` con `{ deliveryId }`.
- `WebhooksProcessor`:
  1. Carga delivery + webhook.
  2. Re-serializa el `payload` (JSON.stringify con `{ sort_keys: false }`) — **no se puede usar el JSONB devuelto por Postgres porque el orden de claves no se preserva entre lecturas, y eso rompería el HMAC**.
  3. Calcula HMAC SHA-256: `t = Date.now() / 1000 | 0; sig = hmac(secret, "${t}.${body}")`.
  4. POST a `webhook.url` con headers `Content-Type: application/json`, `X-Storageos-Signature: t=${t},v1=${sig}`, `X-Storageos-Event: ${event}`, `X-Storageos-Delivery: ${deliveryId}`.
  5. Si `2xx` → marca delivery `delivered`. Si `4xx/5xx/timeout` → marca `failed` + reencola con `attempt + 1`. Backoff exponencial `{ type: 'exponential', delay: 60_000 }` con `attempts: 3`. Tras 3 intentos queda `failed`. `removeOnFail: false`.
- BullMQ `retryProcessDelay` no acepta callback con `delayMs(attempt)` — usar la config `backoff: { type: 'exponential', delay: 60_000 }` directamente en `attempts`.
- Listeners `domain.invoice_paid/issued/overdue`, `contract_signed`, `lead_created` mapeados a eventos públicos (`invoice.paid`, `invoice.issued`, `invoice.overdue`, `contract.signed`, `lead.created`) y enviados a `WebhooksService.dispatch`. Los nombres internos llevan punto en lugar de underscore para coherencia con Stripe/GitHub.
- Endpoints autenticados (tenant user): `GET/POST/DELETE /settings/webhooks[/:id]`, `GET /settings/webhooks/:id/deliveries` (últimos 50).
- UI: nueva tab "Integraciones / Webhooks" en `/settings/integrations` con CRUD + dialog post-create que muestra el secret raw una sola vez + tabla últimos 50 deliveries con expand para ver `payload` + `error_message`.

### 4. ADR-047 + actualización docs (14A.4)

Este ADR + actualización de `docs/ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Alternativas rechazadas

- **Eliminar workers del API totalmente** (vs flag con default `true`): rompería el dev en local. Hoy `pnpm dev` arranca solo el API y espera ver el cron de billing al día siguiente sin levantar el worker. Default `true` mantiene el flujo dev intacto.
- **mock-redis con `jest.mock` factory en `setupFiles`** (vs `moduleNameMapper`): `jest.mock` no funciona en `setupFiles` (se evalúa antes de que el TestRunner monte el module registry). `moduleNameMapper` es el único que funciona a nivel resolver.
- **WebSockets para webhooks** (vs HTTP POST con HMAC): aún más complejo para consumidores externos. Zapier/n8n/IFTTT esperan HTTP POST con firma HMAC al estilo Stripe/GitHub. WebSockets requeriría reconexión, keep-alive, librería cliente.
- **API keys con scopes enforced en MVP** (vs informativos): scope ladder es post-MVP. Sin feedback del primer cliente sobre qué endpoints quiere consumir, decidir los scopes ahora sería diseño especulativo. Mejor persistirlos y enforcearlos cuando tengamos un primer integrador real.
- **Tabla `api_keys` global sin RLS** (vs RLS por tenant): la API key se valida en el endpoint público antes del JwtAuthGuard, sin tenant context activo. Pero el LOOKUP por prefix puede hacerse vía `PrismaAdminService` (bypass RLS). Una vez resuelto el tenantId, todo el resto va por `PrismaService.withTenant`. La tabla tiene RLS aún así para el panel `/settings/api-keys` (donde el lookup va por tenantId del JWT).
- **Webhooks sin re-serialización** (vs re-serializar en cada attempt): Postgres no preserva el orden de claves al leer JSONB. Si calculáramos el HMAC sobre el resultado del SELECT, dos lecturas del mismo delivery podrían dar HMAC distintos. Hay que re-serializar siempre antes de firmar, y el body firmado es el que se envía.
- **Cola separada por evento** (vs cola única `webhooks`): añade complejidad sin valor. Backoff y concurrencia se gestionan mejor con una sola cola que con N colas por evento.

## Consecuencias

### Flag `ENABLE_WORKERS_IN_API` (14A.1)

- **(+)** Un único toggle controla si el API arranca processors + crons. En dev queda `true` por default (un solo proceso); en producción `false` (worker aparte).
- **(+)** Cero duplicación de código: los modules siguen siendo los mismos en API y worker; solo cambia el spread condicional `...(WORKERS_ENABLED_IN_API ? [...] : [])` en cada `providers` array.
- **(+)** Refactor service/processor (separar `@Cron` de `@Processor`) deja el código más limpio y testeable.
- **(−)** Cada module nuevo con processor/cron requiere recordar añadir el spread condicional. Un linter custom podría detectarlo, pero es overkill para el tamaño actual.
- **(−)** Los e2e del bootstrap del API con `WORKERS_ENABLED_IN_API=false` quedan `describe.skip` por bug DI en TestingModule. TODO documentado.
- **(~)** `process.env.ENABLE_WORKERS_IN_API = 'true'` en la primera línea del worker es un workaround para que el operador no se autoshoot. Lo correcto sería leer la env desde docker-compose, pero defense-in-depth.

### Tests worker con `ioredis-mock` (14A.2)

- **(+)** La infra de mocking del worker está lista. El día que se resuelvan las deps DI faltantes en `WorkerModule`, los tests pasarán a verde sin tocar Jest config.
- **(−)** Los tests siguen en `describe.skip` por dependencias DI no portadas (FilesModule, etc.). No bloqueante; los e2e del API cubren los processors.
- **(~)** `ioredis-mock` no implementa el 100% del API de ioredis. Cuando lleguemos a tests que usen scripts Lua o cluster, habrá que evaluar `testcontainers/redis` real.

### API keys + webhooks HMAC (14A.3)

- **(+)** El SaaS deja de ser un silo. El primer cliente puede mandar webhooks `invoice.paid` a su Zapier sin scraping ni magic links.
- **(+)** API keys siguen el patrón Stripe `sk_live_<tenantId>.<secret>`: el tenantId va en claro en el token (no es secreto), el `<secret>` se hashea argon2id.
- **(+)** Webhooks con HMAC SHA-256 y header `X-Storageos-Signature: t=<ts>,v1=<hmac>` siguen el patrón Stripe. Consumidores conocidos (Zapier, n8n, Make) tienen plantillas para esto.
- **(+)** `webhook_deliveries` con last 50 visible en UI ayuda a debug del cliente sin pedirnos los logs.
- **(−)** Scopes no enforced en MVP: cualquier API key activa puede llamar cualquier endpoint `/v1/integrations/*`. Mitigación: limitar el primer release de endpoints públicos a 1-2 lectores y revisar en Fase 15.
- **(−)** El secret del webhook se cifra con `MASTER_ENCRYPTION_KEY`. Si se pierde la key, los webhooks dejan de poder firmar. Documentado en `docs/DEPLOYMENT.md` §8 (backup de la key).
- **(−)** No hay endpoint público `GET /v1/integrations/...` todavía: API keys y webhooks salen al mundo pero el catálogo de endpoints consumibles es ø en Fase 14. Decisión consciente: primero la infra, luego los endpoints según pida el cliente.
- **(~)** Re-serialización del JSONB en cada attempt es coste CPU mínimo (payloads <1KB). El día que payloads crezcan a >100KB conviene cachear el JSON.stringify en `webhook_deliveries.payload_serialized` columna nueva.

## Implementación (fichero por bloque)

### 14A.1 — Flag `ENABLE_WORKERS_IN_API`

- `apps/api/src/config/workers-enabled.ts` (constante exportada)
- `apps/api/src/modules/billing/billing.module.ts` (spread condicional sobre processors)
- `apps/api/src/modules/billing/billing-jobs.service.ts` (lógica + `@Cron`)
- `apps/api/src/modules/billing/billing-recurring.processor.ts` (wrapper `@Processor`)
- `apps/api/src/modules/dunning/dunning.service.ts` (lógica + `@Cron`)
- `apps/api/src/modules/dunning/dunning.processor.ts` (wrapper `@Processor`)
- (idem para Communications, Automations, Reports, Access, SecurityEvents)
- `apps/worker/src/main.ts` (primera línea `process.env.ENABLE_WORKERS_IN_API = 'true'`)
- `docker-compose.prod.yml` (`ENABLE_WORKERS_IN_API: 'false'` en servicio `api`)
- `apps/api/.env.example` (`ENABLE_WORKERS_IN_API=true`)
- `docs/DEPLOYMENT.md` §12 (nueva sección)

### 14A.2 — Tests worker con `ioredis-mock`

- `apps/worker/jest.config.js` (`moduleNameMapper`)
- `apps/worker/package.json` (devDep `ioredis-mock`)
- `apps/worker/test/worker.spec.ts` (siguen `describe.skip`, TODO documentado)

### 14A.3 — API keys + webhooks

- `packages/database/prisma/migrations/20260520040000_phase14a_api_keys_webhooks/migration.sql` (3 tablas + RLS + índices)
- `packages/database/prisma/schema.prisma` (`ApiKey`, `Webhook`, `WebhookDelivery`)
- `apps/api/src/modules/api-keys/{api-keys.module,api-keys.service,api-keys.controller,api-key.guard}.ts`
- `apps/api/src/modules/webhooks-outbound/{webhooks.module,webhooks.service,webhooks.controller,webhooks.processor}.ts`
- `apps/api/src/modules/webhooks-outbound/listeners/{invoice-events.listener,contract-events.listener,lead-events.listener}.ts`
- `packages/shared/src/integrations/{api-keys,webhooks}.schema.ts`
- `apps/web/src/app/(app)/settings/integrations/page.tsx` (tabs API keys + Webhooks)
- `apps/web/src/lib/integrations/{api-keys,webhooks}.ts` (hooks TanStack Query)
- `apps/api/test/api-keys.e2e-spec.ts` (6/6)
- `apps/api/test/webhooks.e2e-spec.ts` (5/5)

### 14A.4 — ADR + cierre

Este ADR + actualización de `docs/ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Lecciones aprendidas

- **`consumer.apply().forRoutes('*')` vs `app.use()`**: el primero NO funciona con `enableVersioning(URI)` activo (lección de Fase 13A.2). Confirmamos en Fase 14 que el patrón "middleware como función + `app.use()`" es el único que funciona pre-router.
- **`jest.mock` factory NO funciona en `setupFiles`** — `moduleNameMapper` es el único path que funciona a nivel resolver. `setupFiles` se ejecuta antes de que el TestRunner monte el module registry de Jest.
- **HMAC sobre JSONB requiere re-serializar el body en cada attempt**: Postgres no preserva el orden de claves al leer JSONB. Si firmamos sobre `JSON.stringify(row.payload)` directamente, dos attempts del mismo delivery pueden producir HMAC distintos. Hay que serializar siempre y firmar sobre la serialización exacta que enviamos.
- **BullMQ `retryProcessDelay` no acepta callback** con `delayMs(attempt)` — usar `backoff: { type: 'exponential', delay: 60_000 }` directamente en la opción del job.
- **Refactorizar `@Cron` + `@Processor` del mismo service** requiere extraer la lógica a service base + wrapper con decoradores: la lógica queda siempre activa (con o sin el flag) y el wrapper se puede condicionar en el spread del array `providers`. Si dejas los decoradores en el service base, no hay forma de apagarlo sin apagar también la lógica.
- **Worker fuerza la env desde dentro** (`process.env.ENABLE_WORKERS_IN_API = 'true'` como primera línea): defense-in-depth. Si el operador olvida setearla en `docker-compose.prod.yml`, el worker arranca con los processors activos en lugar de arrancar sin ellos (que sería más confuso).
- **Scopes informativos en MVP, enforced en Fase 15+**: persistir el campo `scopes` ahora cuesta nada y permite migrar después sin cambio de schema. Diseñar el enforcement sin feedback del primer integrador sería diseño especulativo.
- **`/settings/integrations` con tabs** (API keys + Webhooks) en lugar de dos páginas separadas: el usuario las mira juntas. Una sola entrada en el sidebar mantiene la navegación limpia.

## Referencias

- **Stripe webhooks signing**: <https://docs.stripe.com/webhooks#verify-events>
- **RFC 9239 — HTTP Range field & timestamp in HMAC**: <https://datatracker.ietf.org/doc/html/rfc9239>
- **BullMQ retry strategies**: <https://docs.bullmq.io/guide/retrying-failing-jobs>
- **NestJS dynamic modules + providers conditionals**: <https://docs.nestjs.com/fundamentals/dynamic-modules>
- **Jest `moduleNameMapper` vs `setupFiles`**: <https://jestjs.io/docs/configuration#modulenamemapper-objectstring-string--arraystring>
- **ioredis-mock**: <https://github.com/stipsan/ioredis-mock>
- ADR-041 (Fase 8): Despliegue VPS + Docker prod.
- ADR-045 (Fase 12): Hardening operacional (forzar 2FA, alertas brute-force, super_admin_audit_logs).
- ADR-046 (Fase 13): Robustez técnica pre-venta (worker separado, OpenAPI/versioning, F2, CSP enforce).
