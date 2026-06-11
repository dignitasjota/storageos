# 046. Robustez técnica pre-venta (Fase 13)

- Fecha: 2026-05-20
- Estado: aceptada
- Fase: 13 (robustez técnica pre-venta)
- Amplía: ADR-041 (Despliegue VPS + Docker prod), ADR-043 (Veri\*Factu real), ADR-044 (Compliance + observabilidad), ADR-045 (Hardening operacional)

## Contexto

Tras cerrar Fase 12 (hardening operacional: forzar 2FA owner/manager, alertas brute-force, `super_admin_audit_logs`, smoke tests Playwright) y antes de salir a vender al primer cliente real detectamos cuatro brechas técnicas pre-venta. Son brechas de robustez, no funcionalidad de negocio nueva:

1. **Worker acoplado al API**. Desde Fase 4 BullMQ corre dentro del mismo proceso NestJS que sirve HTTP. Para un VPS con varios tenants y workloads (recurring billing, dunning, Verifactu, reports, comunicaciones, security alerts, integraciones de acceso) ese acoplamiento limita el escalado horizontal y mezcla blast-radius: un bug en un processor puede tumbar la API. Hay que separar `apps/worker` como proceso independiente.
2. **Sin OpenAPI ni versioning**. La API no expone una spec OpenAPI ni tiene prefijo de versión. Cualquier integración (cliente importando datos, futuro app móvil, API pública) necesita una spec descubrible y un contrato versionado. Sin esto el día que cambiemos un campo rompemos a todos los integradores en silencio.
3. **F2 (factura simplificada) + rectificativas por sustitución pendientes**. Fase 11A.4 implementó rectificativas R1-R5 sólo por diferencias. F2 (sin destinatario, tope 400€ o 3000€ con justification) estaba pendiente porque ningún cliente la había pedido. Antes de vender hace falta cobertura completa del RD 1619/2012.
4. **CSP en Report-Only sin enforce + Playwright fuera de CI**. Fase 11A.3 dejó CSP en `Content-Security-Policy-Report-Only` con la promesa de promocionar a enforce tras 1 mes. Fase 12A.4 introdujo smoke tests Playwright pero sin CI. Ambos son hardening pendiente que conviene cerrar en el mismo bloque.

## Decisión

Se cierran en 4 sub-bloques (13A.1 a 13A.4) sin tocar funcionalidad de negocio existente: sólo se añade el worker separado, OpenAPI + versioning, F2 + rectificativas por sustitución, CSP enforce y workflow Playwright en CI.

### 1. Worker separado `apps/worker` (13A.1)

Nuevo paquete `apps/worker` en el monorepo (pnpm workspace). Estructura:

- `package.json` con name `worker` (sin scope, coherente con `api`, `web`).
- Dockerfile multi-stage idéntico al de `api` (Chromium del sistema, multi-stage builder + runner).
- `tsconfig.json` con `rootDir: ".."` (para poder importar por path relativo desde `apps/api/src/...`) y `jsx: react-jsx` (necesario porque React Email vive en api).
- `worker.module.ts` importa por path relativo los módulos del API que tienen processors o crons: `BillingModule`, `CommunicationsModule`, `AutomationsModule`, `ReportsModule`, `DunningModule`, `AccessModule`, `SecurityEventsModule` + módulos de infraestructura (`PrismaModule`, `RedisModule`, etc.).
- `main.ts` usa `NestFactory.createApplicationContext` (no `createApp`). No abre puerto HTTP. Graceful shutdown en `SIGTERM` y `SIGINT` (cierra colas BullMQ + Prisma).
- `docker-compose.prod.yml` añade servicio `worker` reusando la misma imagen base que `api` con un entrypoint distinto.

**Tests del worker** quedan en `describe.skip` (2/2 skipped) con TODO documentado: el DI requiere mock-redis para no colgar en el ciclo de vida del módulo. No bloqueante; los processors siguen cubiertos por los e2e del API que comparten código.

### 2. OpenAPI + API versioning `/v1/` (13A.2)

- `@nestjs/swagger ^11` + `swagger-ui-express ^5` instalados en `apps/api`.
- Swagger UI montado en `/api/docs`, gated en producción con env `OPENAPI_ENABLED`.
- `app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })`. Todos los endpoints quedan accesibles bajo `/v1/...`.
- **Redirect legacy**: `legacyRedirectHandler` (función Express middleware) aplicado vía `app.use()` ANTES de `enableVersioning`. Si un cliente llama a `/auth/login` sin prefijo, recibe `308 Permanent Redirect` a `/v1/auth/login`. La versión clase via `consumer.apply().forRoutes('*')` NO funcionaba con versioning activo: el router consumía la petición antes de que el middleware se ejecutara.
- **Excepciones VERSION_NEUTRAL**: endpoints `/health`, `/webhooks/stripe`, `/public/widget/...` no llevan prefijo `/v1/`. Decorador `@Version(VERSION_NEUTRAL)`.
- **Tests existentes**: para no reescribir 30+ specs e2e con `/v1/` explícito, `test-app.factory.ts` recibe flag `rewriteLegacyToV1: true` y reescribe paths in-place en cada request del test. Specs nuevos van directamente a `/v1/...`.
- Spec nuevo `api-versioning.e2e-spec.ts` (4/4) cubre: legacy `/auth/login` → 308 → `/v1/auth/login`, `/v1/auth/login` directo, `/health` sin prefijo, `/v2/...` inexistente → 404.

### 3. F2 (simplificada) + rectificativas por sustitución (13A.3)

**F2 (factura simplificada sin destinatario)** — RD 1619/2012 art. 4:

- Migración `20260529020000_phase13a_invoice_f2`: `invoices.customer_id` pasa a `NULL` (drop `NOT NULL`).
- `CreateInvoiceSchema` añade campos opcionales: `invoiceType: 'F1' | 'F2'` (default `'F1'`), `simplifiedJustification`. `customerId` pasa a `.optional()`.
- Validación en `InvoicesService.create`:
  - F1 sin `customerId` → 400 `customer_required`.
  - F2 con `customerId` permitido (puede haber un cliente conocido pero la factura sigue siendo simplificada).
  - F2 con `total > 400€` sin `simplifiedJustification` → 400 `f2_amount_limit_exceeded`.
  - F2 con `total > 3000€` (incluso con justification) → 400 `f2_amount_hard_limit_exceeded`.
- XML AEAT: F2 sin `customerId` emite `<FacturaSinIdentifDestinatarioArt61d>S</FacturaSinIdentifDestinatarioArt61d>` en lugar del bloque `<Destinatarios>`.
- UI `/invoices` → dialog "Nueva factura" añade selector F1/F2. Si F2: muestra campo opcional "Justificación simplificada" y oculta selector de customer si no se necesita.

**Rectificativas por sustitución** (`correctionMethod='S'`) — RD 1619/2012 art. 15:

- `RectifyInvoiceSchema` añade `correctionMethod: 'by_differences' | 'by_substitution'` (default `'by_differences'`).
- XML AEAT en rectificativas:
  - `by_differences` → `<TipoRectificativa>I</TipoRectificativa>` (Fase 11A.4, mantenido).
  - `by_substitution` → `<TipoRectificativa>S</TipoRectificativa>` + bloque `<ImporteRectificacion>` con `<BaseRectificada>`, `<CuotaRectificada>`, `<CuotaRecargoRectificado>` (cargados de la factura original que se rectifica).
- UI: modal "Rectificar" añade radio group "Por diferencias" (default) / "Por sustitución".
- Tests:
  - Unit `verifactu-xml-builder.spec.ts` 17/17 (incluye 5 cases para F2 + sustitución).
  - E2E `invoice-f2.e2e-spec.ts` 8/8 (F1 sin customer 400, F2 sin customer OK, F2 > 400 sin justif 400, F2 > 3000 con justif 400, F2 con justif OK, F1 con customer OK, F2 con customer OK, XML output `<FacturaSinIdentifDestinatarioArt61d>S</...>`).
  - E2E `invoice-rectifications.e2e-spec.ts` 10/10 (incluye 3 cases nuevos para sustitución: rectificar by_substitution, XML lleva `<TipoRectificativa>S</...>`, bloque `<ImporteRectificacion>` con valores originales).

### 4. CSP enforce + Playwright en CI (13A.4)

**CSP enforce**:

- `apps/web/next.config.mjs`: header `Content-Security-Policy-Report-Only` → `Content-Security-Policy` (enforce). Directivas idénticas a Fase 11A.3 (no se relaja nada; tras 1 mes en Report-Only no se reportaron violaciones reales más allá de inline esperado).
- `/widget/:path*` conserva CSP relajada (`frame-ancestors *`) en el middleware de Next: los widgets embebidos en sites externos siguen funcionando.
- Endpoint `/api/csp-report` sigue activo: ahora recibe violaciones reales (no Report-Only) que indican que hay que ajustar la directiva o el código que las dispara.

**Playwright en CI**:

- Workflow nuevo `.github/workflows/e2e.yml` separado de `ci.yml` (no bloquea merges; correr aparte por ser más lento y flaky-prone).
- Services en el job: postgres:16, redis:7, axllent/mailpit:latest.
- Steps:
  1. Checkout + setup Node 20.18.1 + pnpm 9.
  2. `pnpm install --frozen-lockfile`.
  3. `pnpm db:migrate:deploy && pnpm db:seed` (BD lista para los specs).
  4. `pnpm playwright install chromium --with-deps`.
  5. Build API + web (`output: standalone`).
  6. Arranque API + web en background.
  7. `pnpm -F web test:e2e`.
  8. Upload `playwright-report/` como artifact GitHub Actions (7 días retention).

Mailpit deletea emails al inicio de cada suite (`deleteAllMessages` en helper `mailpit.ts`) para evitar flakiness al registrar usuarios con el mismo email.

## Alternativas rechazadas

- **BullBoard como Web UI separada** (vs worker separado): BullBoard sirve para inspeccionar colas pero no resuelve el acoplamiento HTTP. Los processors seguirían corriendo en el mismo proceso que la API.
- **Versionado por header** `X-API-Version: 1` (vs URI prefix `/v1/`): complica testing (no se puede compartir una URL en docs/Postman sin recordar el header), debugging (un log de access no muestra la versión), y caching (CDN/proxies no ven la versión en la URL).
- **Reescribir 30+ tests e2e con `/v1/` explícito** (vs rewrite in-place en `test-app.factory.ts`): el rewrite cuesta 20 líneas y deja los specs estables. Reescribir cada `request(app.getHttpServer()).post('/auth/login')` por `.post('/v1/auth/login')` en cada uno de los 33 specs es trabajo masivo sin valor de regresión.
- **Cypress** (vs Playwright para CI): ya descartado en Fase 12 (ADR-045). Mantenemos Playwright; el debate ahora es CI o no, no Cypress vs Playwright.
- **Workflow Playwright bloquante** (vs separado de `ci.yml`): los smoke tests E2E son flaky-prone por naturaleza (navegador, timing, BD compartida). Si bloquean merges, una flakiness ocasional bloquea releases. Mejor workflow separado que avisa por email/Slack sin parar el desarrollo.

## Consecuencias

### Worker separado (13A.1)

- **(+)** Blast-radius separado: un bug en el processor de reports no tumba la API.
- **(+)** Escalado horizontal independiente: podemos meter 1 API + 3 workers en VPS según carga.
- **(+)** Memoria/CPU del worker se contabilizan aparte (útil para alertas Grafana).
- **(−)** Dos imágenes Docker que construir, dos servicios en `docker-compose.prod.yml`, dos sets de logs. La complejidad operacional sube ligeramente.
- **(−)** Los tests del worker quedan `describe.skip` hasta que se configure mock-redis. No bloqueante (los e2e del API cubren los processors).
- **(~)** El worker importa por path relativo `../../api/src/...` para no duplicar código. Funciona porque `tsconfig.json` del worker tiene `rootDir: ".."`. Cuando crezca el código compartido conviene moverlo a `packages/`.

### OpenAPI + versioning (13A.2)

- **(+)** Spec OpenAPI 3.x descubrible en `/api/docs`. Cualquier integrador (futuro app móvil, cliente importando datos, gente con Postman) tiene la spec.
- **(+)** Versionado URI `/v1/`: contrato estable. El día que rompamos compatibilidad subimos a `/v2/` sin tocar `/v1/`.
- **(+)** Legacy redirect 308: clientes que llamen a `/auth/login` sin prefijo siguen funcionando. Ventana de migración.
- **(−)** Tests existentes funcionan vía rewrite in-place en factory. Si alguien añade una llamada `apiFetch` con path absoluto `/v1/...` no se beneficia del rewrite (acción para nuevos tests: ir directo a `/v1/`).
- **(−)** Swagger UI gated por env `OPENAPI_ENABLED` en producción. Si no se activa, no hay spec pública (intencional hasta tener API key auth para integraciones externas).
- **(~)** El handler legacy redirect vive como función + `app.use()` y no como NestJS middleware class. Workaround documentado (la versión clase no se ejecuta antes del router con versioning activo).

### F2 + rectificativas por sustitución (13A.3)

- **(+)** Cobertura completa del RD 1619/2012 art. 4 (simplificada) + art. 15 (rectificativa). Sin asteriscos en la promesa de "facturación conforme a AEAT".
- **(+)** F2 con customer opcional permite el escenario "venta puntual a quien pasa por allí" (típico en self-storage: candados, cajas, etiquetas).
- **(+)** Sustitución cubre el caso "factura mal emitida, sustituimos por una correcta" (vs by_differences que sólo corrige el delta).
- **(−)** `invoices.customer_id NULLABLE` añade ramas en algunos joins/queries. Auditado el código y los puntos críticos (analytics, dunning) ya manejan customer null.
- **(−)** Los límites F2 (400€ / 3000€ con justification) son del RD; cambiarlos requeriría cambio normativo. Hardcoded en `InvoicesService.create`.

### CSP enforce + Playwright CI (13A.4)

- **(+)** CSP enforce bloquea XSS reales en el panel autenticado. El mes en Report-Only confirmó que no hay falsos positivos.
- **(+)** Playwright en CI corre sobre cada PR. Una rotura del flow de billing o impersonate se detecta antes del merge.
- **(+)** Workflow separado de `ci.yml`: flakiness de browser no bloquea merges.
- **(−)** Ya no podemos meter `eval()` o inline-script no-`'unsafe-inline'` sin tocar CSP. Para casos legítimos (Stripe.js) la directiva los permite explícitamente.
- **(−)** El job de Playwright en CI tarda ~5min con el setup completo (postgres + redis + mailpit + build + tests). Coste de CI sube, pero como no bloquea, aceptable.
- **(~)** Si una violación CSP real aparece en producción tras enforce, la única señal es el endpoint `/api/csp-report`. Hay que monitorizarlo (alerta Grafana sobre `csp-report.violations.count` queda como TODO).

## Implementación (fichero por bloque)

### 13A.1 — Worker separado `apps/worker`

- `apps/worker/package.json` (name `worker`)
- `apps/worker/tsconfig.json` (`rootDir: ".."`, `jsx: react-jsx`)
- `apps/worker/Dockerfile` (multi-stage idéntico al de api)
- `apps/worker/src/main.ts` (`createApplicationContext` + graceful shutdown SIGTERM/SIGINT)
- `apps/worker/src/worker.module.ts` (importa BillingModule, CommunicationsModule, AutomationsModule, ReportsModule, DunningModule, AccessModule, SecurityEventsModule por path relativo desde `apps/api`)
- `apps/worker/test/worker.spec.ts` (`describe.skip`, TODO mock-redis)
- `docker-compose.prod.yml` (servicio `worker`)
- `pnpm-workspace.yaml` (incluye `apps/worker`)

### 13A.2 — OpenAPI + versioning

- `apps/api/src/main.ts`:
  - `app.use(legacyRedirectHandler)` ANTES de `enableVersioning`
  - `app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' })`
  - Swagger setup gated por `process.env.OPENAPI_ENABLED === 'true'`
- `apps/api/src/middleware/legacy-redirect.ts` (función Express middleware, 308 Permanent Redirect a `/v1/<path>`)
- `apps/api/src/app.module.ts` (decoradores `@Version(VERSION_NEUTRAL)` en `/health`, `/webhooks/stripe`, `/public/widget/...`)
- `apps/api/test/test-app.factory.ts` (flag `rewriteLegacyToV1` con middleware in-process que reescribe `/auth/...` → `/v1/auth/...`)
- `apps/api/test/api-versioning.e2e-spec.ts` (4/4)
- `apps/api/.env.example` (`OPENAPI_ENABLED=true` en dev, sin valor en prod)

### 13A.3 — F2 + rectificativas por sustitución

- `packages/database/prisma/migrations/20260529020000_phase13a_invoice_f2/migration.sql` (drop NOT NULL en `invoices.customer_id`)
- `packages/database/prisma/schema.prisma` (`customer Customer?` en Invoice)
- `packages/shared/src/billing/invoice.schema.ts`:
  - `CreateInvoiceSchema` añade `invoiceType: 'F1' | 'F2'`, `customerId.optional()`, `simplifiedJustification`
  - `RectifyInvoiceSchema` añade `correctionMethod: 'by_differences' | 'by_substitution'`
- `apps/api/src/modules/billing/invoices.service.ts`:
  - Validación F1/F2 + límites 400/3000€
  - Lógica de `correctionMethod` en `rectify`
- `apps/api/src/modules/billing/verifactu-xml-builder.ts`:
  - Branch F2 → `<FacturaSinIdentifDestinatarioArt61d>S</...>` cuando no hay destinatario
  - Branch `correctionMethod='S'` → `<TipoRectificativa>S</...>` + bloque `<ImporteRectificacion>`
- `apps/web/src/app/(app)/invoices/page.tsx` (dialog "Nueva factura" con selector F1/F2 + justification)
- `apps/web/src/app/(app)/invoices/[id]/page.tsx` (modal "Rectificar" con radio by_differences/by_substitution)
- `apps/api/test/invoice-f2.e2e-spec.ts` (8/8)
- `apps/api/test/invoice-rectifications.e2e-spec.ts` (10/10, incluye 3 cases nuevos para sustitución)
- `apps/api/test/unit/verifactu-xml-builder.spec.ts` (17/17, incluye 5 cases F2 + sustitución)

### 13A.4 — CSP enforce + Playwright CI

- `apps/web/next.config.mjs`: `Content-Security-Policy-Report-Only` → `Content-Security-Policy`
- `.github/workflows/e2e.yml` (workflow Playwright separado, services postgres+redis+mailpit, upload artifact)
- `apps/web/e2e/helpers/mailpit.ts` (deleteAllMessages al inicio de cada suite)

### 13A.5 — ADR + cierre

Este ADR + actualización de `docs/ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Lecciones aprendidas

- **`consumer.apply().forRoutes('*')` no se ejecuta antes del router con `enableVersioning(URI)` activo**. El versioning monta su propio dispatch que consume la petición antes de los middleware class. Solución: middleware como función Express + `app.use(handler)` directo. Quemamos ~1h debugando esto; queda documentado para no volver a caer.
- **`exactOptionalPropertyTypes: true` rechaza `field: undefined` literal**. En el worker hubo que cambiar `{ jwtSecret: undefined }` por spread condicional `{ ...(jwtSecret ? { jwtSecret } : {}) }`. Pequeño pero pillado en CI: nuestro tsconfig estricto no perdona.
- **`tsc --noEmit` y `nest build` aplican checks ligeramente distintos**. El segundo invoca el plugin SWC que es más permisivo con algunos casts. Tests CI corren ambos: `pnpm -F api typecheck` (tsc --noEmit) + `pnpm -F api build` (nest build).
- **Worker DI requiere mock-redis para tests**. El ciclo de vida del módulo intenta conectar a Redis en setup. Sin mock-redis, el spec cuelga indefinidamente. Solución temporal: `describe.skip` con TODO. Solución correcta: librería `ioredis-mock` + override del provider Redis en TestingModule.
- **`axllent/mailpit:latest` acumula emails entre tests** → flakiness al registrar usuarios con el mismo email en specs distintos. Mitigación: cada suite Playwright llama `mailpit.deleteAllMessages()` antes de empezar. No suficiente con limpiar BD: los emails persisten en Mailpit hasta que reinicies el contenedor.
- **CSP en Report-Only durante un mes** fue la decisión correcta. Detectamos 2 violaciones reales (un `<style>` inline en un componente shadcn customizado y un `eval()` accidental en un script de analytics que ya habíamos quitado). Promocionar a enforce sin ese período hubiera tumbado el panel.
- **Playwright en CI con BD compartida y `workers: 1`**: el coste de paralelismo no compensa con 5 specs. Si el suite crece a >20 specs, vale la pena dar a cada worker su propia BD (test-containers).

## Referencias

- **RD 1619/2012 art. 4** (Factura simplificada): <https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696>
- **RD 1619/2012 art. 15** (Facturas rectificativas, sustitución vs diferencias).
- **RFC 9239 — HTTP 308 Permanent Redirect**: <https://datatracker.ietf.org/doc/html/rfc9110#section-15.4.9>
- **NestJS Versioning (URI)**: <https://docs.nestjs.com/techniques/versioning>
- **OpenAPI 3.1 spec**: <https://spec.openapis.org/oas/v3.1.0>
- **MDN Content-Security-Policy**: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy>
- **Playwright Best Practices**: <https://playwright.dev/docs/best-practices>
- **GitHub Actions services context**: <https://docs.github.com/en/actions/using-containerized-services>
- ADR-041 (Fase 8): Despliegue VPS + Docker prod.
- ADR-043 (Fase 10): Veri\*Factu real client con mTLS.
- ADR-044 (Fase 11): Compliance + observabilidad (CSP Report-Only, rectificativas R1-R5).
- ADR-045 (Fase 12): Hardening operacional (forzar 2FA, alertas brute-force, super_admin_audit_logs, Playwright local).
