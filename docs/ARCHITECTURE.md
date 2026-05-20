# ARCHITECTURE

Decisiones arquitecturales del proyecto. Cada decisión va con su justificación para que sea fácil revisarlas en el futuro.

## ADR-001: Monorepo con pnpm + Turborepo

**Decisión:** monorepo único.
**Por qué:** compartir tipos, DTOs y componentes UI entre backend y frontend sin duplicar; pipeline CI unificado; refactors atómicos.
**Alternativas descartadas:** repos separados (más fricción), Nx (más potente pero más complejo de lo que necesitamos).

## ADR-002: NestJS para backend

**Decisión:** NestJS sobre Node.js 20.
**Por qué:** arquitectura modular clara (módulos, controllers, services, guards), DI nativa, ecosistema TypeScript unificado con Next.js, excelente para SaaS multi-tenant.
**Alternativas descartadas:** Express puro (sin estructura), FastAPI (rompe la unidad TS).

## ADR-003: PostgreSQL + Prisma

**Decisión:** Postgres 16 como única BBDD, Prisma como ORM.
**Por qué:** transacciones, JSONB, Row-Level Security, full-text search, extensiones. Prisma da type-safety end-to-end y migraciones declarativas.
**Alternativas descartadas:** MySQL (peor JSON y RLS), TypeORM (peor DX), Drizzle (más nuevo, menor ecosistema).

## ADR-004: Multi-tenancy con shared schema + RLS

**Decisión:** todas las tablas con `tenant_id`, aisladas vía Row-Level Security de Postgres.
**Por qué:** balance óptimo entre coste, complejidad y aislamiento para nuestra escala objetivo (cientos de tenants).
**Cuándo reconsiderar:** si un tenant pesa más del 20% del total, considerar moverlo a una BBDD dedicada. Si superamos los 1000 tenants, evaluar sharding por región.

## ADR-005: Next.js 15 App Router

**Decisión:** Next.js con App Router y React Server Components donde tenga sentido.
**Por qué:** SSR/streaming gratis, mejor SEO para landing y portal público, ecosistema enorme, gran DX.

## ADR-006: Docker + VPS con Portainer + Nginx Proxy Manager

**Decisión:** despliegue en VPS único dockerizado, gestionado con Portainer, con NPM como reverse proxy y SSL.
**Por qué:** coste muy bajo, control total, infraestructura ya disponible, portable a cualquier cloud el día de mañana.
**Riesgos asumidos:** single point of failure, uptime ~99.5%. Mitigación: backups automáticos cifrados a almacenamiento externo + plan de migración listo.
**Cuándo reconsiderar:** al superar ~100-200 tenants activos o cuando se necesite SLA > 99.9%. Migrar entonces a Hetzner Cloud con managed Postgres + balancer, o AWS ECS.

## ADR-007: MinIO para almacenamiento de archivos

**Decisión:** MinIO autohospedado, S3-compatible.
**Por qué:** evita acoplarnos a AWS, mismo SDK que S3, fácil migrar a S3/R2/B2 después.

## ADR-008: BullMQ para colas

**Decisión:** BullMQ sobre Redis para todas las tareas asíncronas.
**Por qué:** facturación recurrente, generación de PDFs, envío de emails, dunning de morosidad, sincronización de accesos. Necesitamos jobs programados (cron) y retries.

## ADR-009: Stripe + GoCardless

**Decisión:** Stripe para tarjetas, GoCardless para SEPA. Capa de abstracción `PaymentGateway` para añadir Redsys en el futuro.
**Por qué:** Stripe es el estándar global, GoCardless lidera SEPA con comisiones bajas (~1%). Redsys es necesario solo si algún cliente lo exige.

## ADR-010: Resend / Brevo para emails

**Decisión:** Resend como primera opción.
**Por qué:** entregabilidad alta, API moderna, plan gratis razonable para empezar. Brevo como plan B si necesitamos SMS y WhatsApp en el mismo proveedor.
**Por qué NO autohospedar SMTP:** los IPs nuevos no llegan a inbox, marcado como spam, gestión de blacklists es un trabajo a tiempo completo.

## ADR-011: UUID v7 como tipo de id

**Decisión:** todos los `id` se generan con la función SQL `uuid_generate_v7()` (plpgsql, sin extensiones externas).
**Por qué:** 48 bits de timestamp ms al inicio → orden cronológico aproximado, menos fragmentación en índices B-tree que UUID v4. Mantenemos la independencia de IDs públicos (no son secuenciales como `serial`).
**Garantía:** monotonía entre milisegundos distintos. Dentro del mismo ms, los bits aleatorios pueden romperla; tests en `packages/database/tests/uuid-v7.test.ts`.

## ADR-012: Identidad de usuario por tenant

**Decisión:** un usuario humano que pertenezca a dos tenants distintos tendrá dos filas separadas en `users`, cada una con su propio `email` único dentro de su tenant.
**Por qué:** simplifica drásticamente el aislamiento con Row-Level Security: cada `user.id` pertenece a un único `tenant_id` y los joins/queries son triviales. La alternativa (usuario global con pertenencia muchos-a-muchos) obligaría a separar autenticación de autorización, complicaría el RLS y abriría la puerta a fugas accidentales entre tenants.
**Coste asumido:** una persona que trabaje para dos clientes ve dos cuentas distintas, con login independiente. Es aceptable: en este sector el solapamiento es raro.
**Cuándo reconsiderar:** si aparece un caso real (franquicia, partner) con muchos usuarios cruzados, valoraremos una capa de identidad global con SSO.

## ADR-013: Dos conexiones Postgres (app + admin)

**Decisión:** la API mantiene dos pools de conexión distintos:

- `storageos_app` (rol restringido, sometido a RLS) → `PrismaService`. Toda query del día a día va por aquí dentro de `withTenant(fn, tenantId)`, que envuelve la operación en una `$transaction` y ejecuta `SELECT set_config('app.current_tenant', $1, true)` antes. Sin contexto, **RLS devuelve cero filas** (deny by default).
- `storageos` (admin, bypass RLS por owner) → `PrismaAdminService`. Solo lo usan flujos que aún no tienen tenant context: `register`, lookup de tenant por slug en `login`, escritura de `audit_logs`, generación de invitaciones y operaciones cross-user dentro del módulo `users` (gestión de roles, transferencia, etc., donde el tenant lo aporta el JWT verificado pero el filtrado por user se hace explícitamente).

**Por qué:** queremos que un bug accidental (`prisma.x.findMany()` sin contexto) no exponga datos de otros tenants. Sin el admin separado, tendríamos que disfrazar las queries cross-tenant del registro y los audit logs.

## ADR-014: Refresh token opaco con rotación + detección de reuso

**Decisión:** refresh token con formato `<tenantId>.<sessionId>.<secret>`:

- `tenantId` (UUID v7) permite cargar el contexto RLS antes de buscar la sesión. No es secreto.
- `sessionId` (UUID v7) identifica la fila en `sessions`.
- `secret` son 32 bytes random base64url. Solo el hash argon2id se persiste; verificación con `argon2.verify`, timing-safe.

Cada refresh **rota** la sesión actual (la marca `revokedReason: rotated`) y crea una nueva con `rotatedFromId`. Si un refresh **ya rotado/revocado** se intenta reusar, hacemos `updateMany` revocando **todas** las sesiones del user con `revokedReason: refresh_reuse`. Tanto el atacante como el usuario legítimo quedan deslogueados → el usuario notará el ataque al volver a hacer login.

**Por qué:** detectar robo del refresh sin necesidad de fingerprinting frágil. Los pasos viven en `SessionsService.rotate` en transacciones separadas para evitar perder la revocación si el flujo posterior lanza (ver comentarios del código).

## ADR-015: Cifrado simétrico de secrets en BD (AES-256-GCM)

**Decisión:** los secretos persistidos (de momento solo TOTP) se cifran con AES-256-GCM usando `MASTER_ENCRYPTION_KEY` (32 bytes base64). `CryptoService` produce un envelope `<iv>.<authTag>.<ciphertext>` en base64url.

**Por qué:** defensa en profundidad. Aunque el RLS aísla por tenant y el rol `storageos_app` no tiene `BYPASSRLS`, un dump de BD (backup, debugging, fuga) expondría los secretos en claro. Cifrar al inicio nos da margen para rotación de claves si fuera necesario.

**Cuándo extender:** cuando lleguen tokens OAuth de terceros (Stripe, GoCardless, integraciones de acceso) o credenciales de webhook, se cifran con el mismo servicio.

## ADR-016: 2FA TOTP opt-in con pendingToken corto

**Decisión:** 2FA se activa por usuario voluntariamente. Si está activado, `POST /auth/login` no emite sesión: devuelve `{ requires2fa, pendingToken, expiresIn }` y el frontend completa el flujo en `POST /auth/2fa/challenge`. El `pendingToken` es un JWT corto (TTL 5 min) firmado con un **secret independiente** (`JWT_2FA_PENDING_SECRET`) y con `purpose: '2fa_pending'` — bajo ningún decoder se confunde con un access JWT.

**Por qué:** mantener el access secret aislado al éxito del segundo factor; impedir que un access token "pre-2FA" exista en ningún punto del flujo. La política de **forzar 2FA** para roles `owner`/`manager` queda para Fase 8 como flag de tenant (`require_2fa_for_managers`), evitando bloquear cuentas existentes durante el rollout.

**Recovery codes:** 10 códigos `XXXX-XXXX` (alfabeto sin ambigüedades I/O/0/1), hashed argon2id, single-use con `updateMany` atómico. Plaintext devuelto **una vez**; perderlos obliga a regenerar (lo que invalida los anteriores).

## ADR-017: Schemas Zod en `packages/shared` para ambos extremos

**Decisión:** todos los schemas de request/response viven en `packages/shared/src/{auth,users}` y se reutilizan en backend y frontend.

- Backend: `nestjs-zod` con `createZodDto(Schema)` los expone como DTOs de NestJS y los valida vía `ZodValidationPipe` global.
- Frontend: `@hookform/resolvers/zod` los conecta a react-hook-form.

**Por qué:** una sola fuente de verdad de las reglas (longitud de password, formato de email, etc.). Cuando una regla cambia, ambos extremos la heredan al rebuild de `@storageos/shared`. No usamos class-validator: añadiría una segunda capa de verdad sobre los mismos campos.

## ADR-018: RolesGuard global con decorador `@Roles(...)`

**Decisión:** un `RolesGuard` registrado como tercer `APP_GUARD` global (orden Throttler → JwtAuth → Roles) lee `@Roles('owner', 'manager')` de la metadata del handler y rechaza con `403 { code: 'insufficient_role' | 'forbidden' }` si no se cumple.

**Por qué:** centraliza la autorización por role; los endpoints solo declaran qué roles los pueden invocar. Las **invariantes de dominio** (único `owner`, transferencia atómica de propiedad, manager no puede asignar manager) se mantienen en `UsersService` con códigos de error específicos (`owner_required`, `insufficient_role`), no en el guard. Esto separa "puedes llamar al endpoint" de "el cambio que pides es válido".

## ADR-020: Cliente AEAT real para Veri\*Factu (ver `adr/008-verifactu-real-client.md`)

**Decisión:** implementar Veri\*Factu (modo verificable, no SII). Cada tenant sube su PKCS#12; el envío se hace por mTLS con `https.Agent` nativo, sin firma XAdES, con cola BullMQ con retry 3× exponencial.

**Por qué:** desde 2026-07-01 toda factura emitida en España debe enviarse al AEAT en tiempo real. El modo verificable (que es el que aplica al sector self-storage) NO requiere firma XAdES, solo encadenamiento de hash + envío inmediato. El tenant es el emisor fiscal real; nosotros operamos solo como software.

**Detalle completo:** ADR independiente en `docs/adr/008-verifactu-real-client.md`.

## ADR-019: Email transaccional con nodemailer + React Email

**Decisión:** en backend usamos `nodemailer` para enviar y `@react-email/components` para componer las plantillas. En dev apuntamos a **Mailpit** (`localhost:1026`); en prod apuntaremos a Resend o Brevo vía SMTP relay (no autohospedamos SMTP, ver ADR-010).

**Por qué:** mantener una única abstracción (`EmailService.send({ to, subject, react: <Template ... /> })`) que funciona igual en dev y prod cambiando solo `SMTP_*`. React Email nos da plantillas tipadas con preview server local (`pnpm --filter api email:dev`). Las plantillas viven en `apps/api/src/modules/email/templates/`.

## Diagrama de servicios (producción)

```
                    Internet
                       |
                       v
            Nginx Proxy Manager (SSL)
            /      |        |        \
           v       v        v         v
       Next.js  NestJS   MinIO   Uptime Kuma
                  |
                  +--> PostgreSQL
                  +--> Redis  <-- BullMQ Worker
```

Todos los servicios viven en una red Docker interna; solo NPM expone puertos al host.

## Flujo de datos crítico: facturación recurrente

1. Cron job (BullMQ scheduler) corre diariamente.
2. Identifica contratos con próxima factura debida.
3. Genera `invoice` + `invoice_items` aplicando reglas de pricing.
4. Genera PDF con Puppeteer y lo sube a MinIO.
5. Encola job de envío por email.
6. Si el método de pago está guardado, encola job de cobro automático.
7. Resultado del cobro actualiza `payment.status`; si falla, encola `dunning_action`.
8. Cada paso queda en `audit_logs`.

## Veri\*Factu: arquitectura del envío AEAT (Fase 10)

A partir del **RD 1007/2023** (entrada en vigor 2026-07-01) cada factura emitida por un tenant español debe enviarse al AEAT en tiempo real (modo "verificable"). StorageOS implementa el envío end-to-end con cliente propio mTLS y certificado por tenant.

### Flujo de envío

```
InvoicesService.issue
    ├─ genera hash encadenado (VerifactuService.computeChainedHash)
    ├─ persiste invoice con aeatStatus = null
    └─ encola job `send-to-aeat` en la cola BullMQ `verifactu`

VerifactuProcessor (worker, concurrency 2, retry 3× exponencial 60s base)
    └─ VerifactuService.sendToAeat(invoiceId)
        ├─ carga el cert del tenant (TenantAeatCredentialsService.getDecrypted)
        ├─ construye XML (VerifactuXmlBuilder.buildRegistroAlta)
        ├─ POST mTLS al endpoint AEAT (RealAeatClient.sendInvoice)
        ├─ parsea respuesta SOAP (EstadoRegistro + CSV + mensaje)
        ├─ persiste aeat_status / aeat_sent_at / aeat_response en invoice
        ├─ si error técnico (timeout, 5xx, TLS) → throw → BullMQ retry (1m, 5m, 25m aprox)
        └─ si rejected (decisión firme AEAT) → no retry, requiere revisión manual
```

### Modos `AEAT_MODE`

| Mode         | Endpoint                                                 | Comportamiento                                            |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------- |
| `stub`       | ninguno                                                  | `StubAeatClient` devuelve `accepted` con CSV sintético    |
| `sandbox`    | `prewww1.aeat.es/.../SistemaFacturacionV1`               | `RealAeatClient` real contra sandbox AEAT (preproducción) |
| `production` | `www1.agenciatributaria.gob.es/.../SistemaFacturacionV1` | `RealAeatClient` real contra producción AEAT              |

El cambio entre modos es exclusivamente por variable de entorno (`AEAT_MODE`). El código de negocio (cálculo de hash encadenado, QR, persistencia) es idéntico en los tres modos.

### Almacenamiento de certificados

Cada tenant sube su propio PKCS#12 (`.p12`/`.pfx`) a la tabla `tenant_aeat_credentials`. El binario se codifica base64 y se cifra como string mediante `CryptoService` (AES-256-GCM con `MASTER_ENCRYPTION_KEY`), igual que los tokens Stripe (ADR-007/ADR-015). La password del certificado se cifra con el mismo mecanismo en una columna independiente. La metadata (CN, NIF, issuer, `notBefore`, `notAfter`) se extrae al subir y se persiste en claro para mostrar el estado en `/settings/billing/verifactu` sin tener que descifrar el certificado en cada render.

En tiempo de envío, el `RealAeatClient` descifra, extrae el cert PEM + clave privada PEM con `node-forge`, y crea un `https.Agent` nativo de Node con `cert`/`key`/`passphrase`. No usamos `axios`, `node-soap` ni `xadesjs` (ver ADR-020).

## Seguridad: defensa en profundidad

- **Red:** firewall del VPS solo abre 80/443; el resto, red Docker interna.
- **App:** rate limiting, validación estricta, CORS configurado, Helmet.
- **Auth:** JWT corto + refresh en httpOnly cookie, 2FA para roles sensibles.
- **BBDD:** RLS por tenant_id, usuario Postgres de la app sin permisos DDL.
- **Secretos:** nunca en repo, gestionados como variables de entorno y montados como Docker secrets en prod.
- **Backups:** cifrados con gpg antes de subir a almacenamiento externo.

## Seguridad: Content Security Policy (frontend)

El frontend `apps/web` aplica una **Content Security Policy** definida en
`apps/web/next.config.mjs` (función `headers()`).

### Modo `enforcement` (desde Fase 13A.4)

La Fase 11A introdujo la CSP en modo **`Content-Security-Policy-Report-Only`**
para auditar violaciones sin romper UX: el navegador respetaba la política
informativamente y enviaba cada bloqueo simulado al endpoint
`POST /api/csp-report` (logueado a stdout → Loki/Grafana en producción).

En la **Fase 13A.4**, tras la ventana de auditoría sin violaciones
inesperadas (incluyendo Fase 12), se cambió la cabecera a
**`Content-Security-Policy`** (enforcement). La lista de directivas y los
dominios permitidos **no cambian**: las mismas reglas que se observaban
ahora bloquean activamente el recurso. El endpoint `/api/csp-report` sigue
montado y activo (la directiva `report-uri` también funciona en modo
enforcement), de modo que si en producción aparecen violaciones reales
quedarán registradas y podremos reaccionar (rollback inmediato volviendo
a `Content-Security-Policy-Report-Only` si fuese necesario).

### Directivas y dominios externos permitidos

| Directiva         | Valores                                                                   | Por qué                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `default-src`     | `'self'`                                                                  | Por defecto solo recursos propios                                                                                        |
| `script-src`      | `'self' 'unsafe-inline' https://js.stripe.com` (+ `'unsafe-eval'` en dev) | Next.js inyecta scripts inline (RSC + hydration). Stripe.js queda preparado por si se añade Elements en cliente          |
| `style-src`       | `'self' 'unsafe-inline'`                                                  | shadcn/ui + Radix usan `style=""` inline en popovers, tooltips, sidebar                                                  |
| `img-src`         | `'self' data: blob: https:`                                               | `data:` para QR Verifactu, `blob:` para previews de upload, `https:` para signed URLs MinIO/S3 (host arbitrario por env) |
| `font-src`        | `'self' data:`                                                            | `next/font` (Geist) puede inlinear como data URI                                                                         |
| `connect-src`     | `'self' https:` (+ `http: ws:` en dev)                                    | Fetch al backend (NEXT_PUBLIC_API_URL, otro origin) + PUT directos a signed URLs MinIO/S3                                |
| `frame-src`       | `'self' https://js.stripe.com https://hooks.stripe.com`                   | `'self'` para el preview del widget en `/settings/widget`                                                                |
| `frame-ancestors` | `'none'`                                                                  | Anti-clickjacking: nadie puede embebernos (excepto el widget, ver abajo)                                                 |
| `form-action`     | `'self'`                                                                  | Impide submits a dominios externos                                                                                       |
| `base-uri`        | `'self'`                                                                  | Impide `<base href>` a otros origenes                                                                                    |
| `object-src`      | `'none'`                                                                  | Sin plugins ni flash                                                                                                     |
| `report-uri`      | `/api/csp-report`                                                         | Endpoint propio para recopilar violaciones                                                                               |

Cabeceras complementarias también aplicadas: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: camera=(), microphone=(), geolocation=()`.

### Excepción `/widget/[slug]`

El widget público está diseñado para **embeberse en webs de terceros**, por
lo que necesita `frame-ancestors *`. La CSP estricta del panel **NO** se
aplica a esta ruta:

- En `next.config.mjs` la regla `source: '/widget/:path*'` solo emite
  `X-Frame-Options: ALLOWALL` (sin CSP estricta).
- En `src/middleware.ts` se inyecta la CSP permisiva del widget
  (`frame-ancestors *; default-src 'self' 'unsafe-inline' data:; ...`).

### Endpoint `/api/csp-report`

`apps/web/src/app/api/csp-report/route.ts`. Recibe POST con el detalle
de cada violación, lo loguea con `console.warn` y devuelve `204 No Content`.
En producción los logs se recogen en Loki/Grafana para analizar antes del
cambio a enforcement.

### Roadmap

1. Fase 11A: `Report-Only` desplegado en producción.
2. Auditoría (Fases 11–12): logs `[CSP violation]` en Loki para identificar
   falsos positivos y dominios no contemplados; ninguno requirió ajustes.
3. **Fase 13A.4 (actual): enforcement activo** (`Content-Security-Policy`).
   El endpoint `/api/csp-report` permanece desplegado por si aparecen
   violaciones reales en producción.
4. Futuro (opcional): migrar `'unsafe-inline'` de `script-src` a nonces
   dinámicos generados en middleware. Queda fuera de scope porque
   requiere recablear todo el render path de Next App Router.
