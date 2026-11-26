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

**Actualización (2026-09-30, #550–#558):** en producción se usan **Brevo y Resend a la vez**. Un `RoutingEmailProvider` (bajo el token `EMAIL_PROVIDER`) decide en cada envío según `platform_email_settings` (principal + respaldo, editable por el super admin); `EMAIL_PROVIDER` queda como valor por defecto. Los correos de un tenant a sus inquilinos salen con su nombre (`TenantSenderService`) y, si tiene dominio propio de correo verificado, desde ese dominio **siempre por Brevo** (los dominios de los tenants viven en la cuenta Brevo de la plataforma). Como esa cuenta es compartida, además de los DNS de Brevo se exige un TXT de propiedad por tenant (`_trasteros.<dominio>`), y la app nunca borra dominios de Brevo por su cuenta.

**Actualización (2026-10-01, #562–#570):**

- **Tres remitentes**: tenant → inquilino (`TenantSenderService`: nombre del tenant, su dominio si está verificado); plataforma → tenant (`PlatformEmailSettingsService.platformSender(category)`: común y por tipo `account`/`billing`/`admin_messages`/`staff_notices`, con dirección de respuesta, herencia tipo → común → `EMAIL_FROM_*`); correos internos al super admin (remitente común).
- **Correos por defecto antes que automatizaciones**: los transaccionales al inquilino (`CustomerEmailsModule`) salen siempre, activables uno a uno por el tenant; una automatización activa del mismo evento los sustituye. Las automatizaciones completan los datos al ejecutarse (`enrich`), no en el evento.
- **Valores sensibles en un envío** (PIN de acceso): `SendArgs.secretVariables` los saca del historial — el cuerpo guardado lleva una marca, el valor va cifrado en `communications.secrets_encrypted` y solo se pone al enviar; el panel ve `••••`.
- **El proveedor puede rechazar después de aceptar**: los avisos de entrega (`EmailEventsModule`, webhooks de Brevo con token y de Resend con firma Svix) actualizan cada comunicación a `delivered`/`bounced`/`failed`; lo que no está en Comunicaciones avisa al super admin. Los correos con enlaces de acceso al portal no se guardan en el historial a propósito.

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

**Margen de gracia (2026-09, #518):** la política paranoid expulsaba a usuarios legítimos de todos sus dispositivos en carreras normales del navegador (una recarga que aborta un `/auth/refresh` en vuelo deja el `Set-Cookie` sin guardar y la página siguiente reenvía el token ya rotado; varias pestañas arrancando a la vez). Ahora un token **rotado hace ≤ 30 s** (`REFRESH_REUSE_GRACE_MS`) y presentado **desde el mismo user-agent** emite una sesión hermana (mismo `rotatedFromId`, tope 3 → al agotarlo, 401 sin revoke-all). Revocado por logout, rotado hace más o desde otro navegador → revoke-all como antes. En el frontend, `AuthBootstrap` comparte la promesa deduplicada de `performRefresh`. Mismo patrón que el _reuse interval_ de Auth0 / _grace period_ de Okta; contrapartida asumida: un refresh robado y usado en esos 30 s con el mismo user-agent no dispara la alarma.

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

**Actualización (2026-10-01, #573–#575) — contabilidad con Holded y la asesoría:**

- **Un solo emisor fiscal**: la app numera, emite y registra en Veri\*Factu. Holded (del tenant o de la plataforma) recibe una **copia contable** y nunca vuelve a registrar: la copia va siempre a una serie de Holded marcada «No enviar a Verifactu», comprobada contra Holded al guardarla; sin serie válida no se envía nada.
- **El número legal viaja en la descripción** del documento de Holded: su API no permite fijar a la vez el número y la serie.
- **La copia sigue la vida de la factura** (`HoldedSyncService`, best-effort sobre eventos): emisión, cobros, rectificativas (credit notes en su serie), simplificadas (contacto genérico) y anulaciones (`domain.invoice_cancelled`). Cliente HTTP propio sobre la API v2 (`Bearer`); la v1 ya no acepta las claves nuevas.
- **Facturas de suscripción completas**: el emisor no puede activar la facturación sin sus datos fiscales; el tenant rellena los suyos; si faltan al cobrar, la factura se emite igual y queda marcada.
- **Asesoría**: formato estándar (`AccountantExportService`, Excel o CSV) que junta las dos actividades de la SL —suscripciones y negocio propio— por factura y tipo de IVA, más cobros. No se integra con programas contables concretos.
- **Rectificativas de suscripción** (#577): serie propia (`SAAS-R-<año>`), por sustitución (corrige los datos del cliente con los mismos importes) o por diferencias (abono parcial o total); la factura original nunca se modifica, solo cambia de estado (`rectified`/`cancelled`).
- Las facturas de suscripción **aún no** se registran en Veri\*Factu (obligatorio para sociedades desde el 1-1-2027).

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

Con el **RD 1007/2023** y la **Orden HAC/1177/2024**, los sistemas de facturación generan un registro por cada factura y, en modo VERI\*FACTU, se los remiten a la AEAT (obligatorio desde el 1-1-2027 para las sociedades y el 1-7-2027 para el resto). TrasterOS lo hace con cliente propio mTLS y el certificado de cada negocio, y **cada negocio lo activa** (`tenants.verifactu_enabled`, apagado por defecto).

### Flujo de envío (2026-11-08/11)

```
InvoicesService.issue (con Veri*Factu activado)
    ├─ VerifactuRecordsService.createAlta
    │    ├─ bloqueo de la cadena del emisor (pg_advisory_xact_lock por negocio o propietario)
    │    ├─ huella encadenada con el registro anterior y FechaHoraHusoGenRegistro
    │    └─ guarda el registro en verifactu_records con su XML tal como se generó
    └─ VerifactuDispatcher.schedule → un trabajo por emisor y hora de salida (cola `verifactu`)

VerifactuProcessor (worker, concurrencia 4)
    └─ VerifactuService.sendPending(tenant, emisor)
        ├─ respeta la espera del emisor (next_send_at, retry_at) y lo reserva (lease_until)
        ├─ lotes de hasta 1.000 registros en el orden de la cadena; los de una incidencia van aparte
        ├─ AeatClient.sendBatch: el XML guardado de cada registro + cabecera (FechaFinVeriFactu, Incidencia)
        ├─ parseSubmissionResponse: resultado por registro, CSV y TiempoEsperaEnvio
        ├─ verifactu_submissions (constancia de cada envío, 4 años) y estado de cada registro
        ├─ syncInvoices: la factura enseña el estado de su último registro
        ├─ sin respuesta (red, 5xx, SoapFault) → se repite a los 1, 2, 4… minutos, como mucho cada hora
        └─ rechazado → no se repite: se corrige con un registro de subsanación
```

### Registros, correcciones y baja

- **Un registro por fila** (`verifactu_records`): alta, subsanación o anulación, con `RefExterna` = id del registro. El XML no se rehace al enviar: si cambian después los datos del cliente, sale lo que se registró.
- **Subsanación** (`POST /billing/invoices/:id/resend-aeat`): lo rechazado o aceptado con avisos se corrige con un registro nuevo al final de la cadena (`Subsanacion=S`, `RechazoPrevio` X si la AEAT nunca tuvo la factura y S si la tenía). Si el error está en algo que se ve en la factura, se rectifica.
- **Anulación** de una factura emitida por error (`POST /invoices/:id/void`): solo sin cobros ni rectificativas; registro de anulación (`SinRegistroPrevio` si la AEAT no la tenía) y la factura sale de los libros.
- **Renuncia** (art. 17): con registros en el año, desactivar programa la baja al 31-12; los envíos hasta entonces llevan `FechaFinVeriFactu` y el cron `verifactu.renuncia` la aplica el 1 de enero si llegó a la AEAT.
- **Incidencias** (art. 16.4): con un emisor fallando, lo pendiente sale marcado (`Incidencia=S`) y el panel avisa de cuántas facturas faltan por llegar.
- **XML validado contra los XSD oficiales** con xmllint en las pruebas (`verifactu-xsd.spec.ts`, XSD en `__tests__/fixtures/aeat-xsd`): cualquier cambio en el XML tiene que pasarla.
- **Declaración responsable** del sistema (art. 15 de la Orden): una por versión (`VERIFACTU_DECLARATIONS` en shared), en `/declaracion-responsable`, en Configuración → Veri\*Factu y en PDF.

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

## Seguridad: primitivas y reglas del código (auditoría 4, 2026-09)

Piezas reutilizables introducidas en la cuarta auditoría (detalle y PRs en
`docs/AUDITORIA.md`). **Usarlas en código nuevo en vez de reimplementarlas.**

- **IP real del cliente** — `common/http/trust-proxy.ts` + env
  `TRUST_PROXY_HOPS` (default 1 = solo Nginx Proxy Manager). Sin ella `req.ip`
  es la IP del proxy: el rate limiting se vuelve global y la auditoría inútil.
  Debe ser el nº EXACTO de proxies (de más → IP falsificable por
  `X-Forwarded-For`).
- **Peticiones salientes a URLs de un tenant** —
  `common/security/safe-http-post.ts` (`checkOutboundUrlShape` +
  `createSafeLookup` + `safePostJson`): la IP resuelta se valida en el `lookup`
  del propio socket (sin ventana de DNS rebinding), sin redirecciones, respuesta
  acotada. `isSafeOutboundUrl` + `redirect: 'manual'` para las cerraduras.
  **Nunca** `fetch` directo a una URL que controle un tenant.
- **Logs y Sentry sin secretos** — `common/logging/sanitize.ts`: serializer
  `req` de pino (url/query/cabeceras; descarta `params`), log de 5xx y
  `beforeSend` de Sentry. Un endpoint nuevo con secretos en la query, en la ruta
  o en una cabecera propia debe añadirse a sus listas.
- **Anti-enumeración por tiempo** — `common/security/dummy-password.ts`
  (argon2 ficticio en las ramas «no existe» de un login) y
  `common/security/respond-then-run.ts` (los endpoints públicos «si el email
  existe te enviamos…» responden ya y trabajan en segundo plano).
- **Sesiones del portal revocables** — `customers.portal_session_version` va en
  el JWT del portal (`sv`) y se compara en cada request; incrementarla invalida
  todas las sesiones del inquilino.
- **2FA** — tope de 5 fallos / 15 min por usuario (`two-factor-limits.ts`) y
  anti-replay TOTP (`two_factor_last_step`, `TotpService.matchStep`).
- **Contenido de terceros en un dominio propio** — `/tenant-site` se sirve con
  `Content-Security-Policy: sandbox` sin `allow-same-origin` (origen opaco): no
  puede leer la sesión del portal, que vive en el mismo origen.
- **Rol restringido de BD** — `storageos_app` no tiene acceso a las tablas
  globales de plataforma (migración `20260925180000`). Los default privileges
  le conceden CRUD en cada tabla nueva: **toda tabla global nueva debe llevar su
  propio `REVOKE` (o RLS) en su migración.**
- **Subidas** — `FilesService.assertObjectMimeType` (en cada endpoint
  «register») valida los magic bytes y el tamaño (≤ `MAX_UPLOAD_BYTES`, 20 MB)
  y borra el objeto rechazado.
- **Riesgos aceptados**: CSP con `'unsafe-inline'` (ver abajo) y la ventana de
  DNS rebinding en cerraduras/Dahua (IP validada + sin redirects).

## Ficheros: URLs firmadas para el navegador (#578)

`FilesService` usa dos clientes S3: uno **interno** (`MINIO_ENDPOINT`, p. ej. `minio:9000` en Docker) para las operaciones del servidor, y otro que **solo firma** con `MINIO_PUBLIC_URL` para las URLs que usa el navegador (subidas directas y descargas de buckets privados). La firma S3 incluye el host, así que una URL firmada con el host interno no sirve fuera de Docker. Cualquier `getSignedUrl` nuevo debe usar el cliente de firma.

## Piezas reutilizables añadidas en 2026-09 (#536, #540)

- **`common/cache/ttl-cache.ts` (`TtlCache<T>`)**: caché en memoria con TTL, **por proceso**, para agregaciones caras de solo lectura (métricas del super admin, «Sugerencias de hoy» con IA). Las peticiones concurrentes a la misma clave comparten la misma promesa y un fallo no se cachea. **TTL 0 en `NODE_ENV=test`** para que los e2e que mutan y releen vean el cambio. Con varias réplicas cada una guarda su copia: vale para cortar refrescos repetidos, no como caché compartida (para eso, Redis).
- **IA como «editor», no como decisor** (`modules/ai/suggested-actions-ranking.ts`): cuando el modelo enriquece una salida del sistema, el motor determinista decide QUÉ se muestra y el modelo solo **reordena y redacta**. Se valida la respuesta (JSON, ids conocidos, longitud), se ignora cualquier id inventado, los campos sensibles (enlaces, categoría, prioridad) salen siempre del original, hay timeout y cualquier fallo vuelve a la salida determinista. Patrón a repetir si se añade IA a otras pantallas.

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
4. **Riesgo aceptado (auditoría 4, 2026-09-25):** se mantiene
   `'unsafe-inline'` en `script-src`. Migrar a nonces obliga a renderizar
   dinámicamente todas las páginas (se pierde la caché estática y la web
   pública va más lenta). Reevaluar si aparece HTML enriquecido escrito por
   usuarios (hoy el Markdown se renderiza sin HTML crudo).

## Correo y comunicaciones: privacidad y entregabilidad (2026-10-01/02, #580–#595)

- **Secretos fuera del historial**: un valor sensible (el PIN) se sustituye por una marca antes de renderizar, se guarda cifrado aparte (`communications.secrets_encrypted`) y solo se pone al enviar. El staff ve el correo con `••••`.
- **Comercial vs transaccional** (LSSI art. 21): `communications.is_marketing`. Un cliente recibe campañas mientras no se dé de baja; un lead solo con consentimiento expreso. La cola lo vuelve a comprobar al enviar; pie de baja + `List-Unsubscribe` de un clic con token HMAC sin estado.
- **Lista de supresión global** (`email_suppressions`): la cuenta Brevo es compartida por todos los tenants, así que un rebote permanente bloquea la dirección para toda la plataforma y una queja de spam la quita de los comerciales de ese tenant. `EmailService.sendRendered` no envía a una dirección bloqueada.
- **Proveedor simulado nunca finge en producción** (WhatsApp `stub` → `skipped`).
- **Avisos por local y leído por usuario** (`notifications.facility_id` + `notification_reads`) y preferencias de correo por usuario (`users.email_notice_prefs`), sin que el usuario pueda reactivar lo que la empresa apaga.
- **Marca e idioma del inquilino** en todo correo que le llega (`tenantEmailShell`, plantillas en inglés si no se editaron).
- **Historial de los correos de la plataforma** (`platform_email_logs`) sin el cuerpo de los correos de cuenta (llevan enlaces de acceso).

## Facturación: reglas fijadas en las dos auditorías (2026-10-02/04, #598–#615)

- **Nada que mueva dinero sin bloqueo**: emitir, cobrar a mano, revertir, reembolsar y confirmar remesas trabajan con la fila de la factura bloqueada (`lockInvoiceRow`) o con transiciones condicionadas (`updateMany`); los avisos de pasarela son idempotentes y la copia en Holded se reserva antes de llamar.
- **Veri\*Factu**: huella oficial, cadena **por emisor** (no por serie) con bloqueo por tenant, fecha del registro guardada al emitir, desglose por tipo de IVA y envíos que consultan antes de reenviar. Cada tenant emite con **su propio certificado**.
- **Dónde se emite** (`tenants.invoicing_mode`): en la app (numera y registra en Veri\*Factu) o en Holded (Holded numera y registra; la app guarda el número y el PDF). El cambio solo vale desde el 1 de enero si ya emitió ese año. Las rectificativas en modo Holded se hacen allí y se enlazan (la API v2 no permite indicar la factura rectificada).
- **Anular = rectificar**: una factura emitida nunca se borra; anularla emite una rectificativa de abono en la **serie propia de rectificativas**. Reembolsar emite el abono automático. Los abonos compensan el pendiente con un pago `credit_note` que no cuenta como dinero cobrado.
- **Redondeo simétrico en céntimos** por línea (base, cuota y total), con `invoice.total ≡ Σ líneas`.
- **Fianza fuera de la factura**: justificante `deposit_receipt` (sin IVA ni Veri\*Factu). Por defecto se cobra en el mismo pago que la 1ª factura y el acceso llega con los dos pagados; en efectivo (`contracts.deposit_payment_method = cash`) va suelto, sin vencimiento, y se registra desde el contrato. Un inquilino puede estar marcado sin fianza.
- **Suscripciones**: las factura el tenant «negocio propio» de TrasterOS SL como facturas suyas (misma serie, cadena y certificado), con el tenant cliente como inquilino; `platform_invoices` es la copia que ve el cliente. Precios con IVA incluido o +IVA; un NIF solo puede pertenecer a una empresa; reembolsos, contracargos perdidos y devoluciones SEPA abonan la factura.
- **Tarjeta de los inquilinos desactivada** (`TENANT_CARD_PAYMENTS_ENABLED=false`): la cuenta de Stripe es la de la plataforma y sin Connect el dinero no sería del tenant. Redsys, Bizum, GoCardless y las remesas SEPA son de cada tenant.

## Configuración del panel del tenant (2026-10-04)

La navegación de `/settings` se define en un único sitio (`apps/web/src/app/(app)/settings/settings-nav.ts`): grupos, páginas, descripción y permiso de cada una, más los ajustes que viven en su módulo (`MODULE_SETTINGS`). El layout pinta el menú lateral (escritorio) o un desplegable (móvil) y la página `/settings` el resumen. Añadir una página de configuración = añadirla a `SETTINGS_NAV` en su grupo.

## Precios: el sistema sugiere, el operador decide (2026-10-04/06, #622–#629)

Un único motor (`apps/api/src/modules/analytics/pricing-engine.ts`, funciones puras con tests) calcula la sugerencia para la vista por tipo, la vista por trastero y «Sugerencias de hoy». **Nunca** cambia un precio ni crea una oferta por su cuenta: el operador pulsa «Aplicar» o «Crear oferta». Cada cambio aplicado se guarda en `unit_price_history` y cada comprobación de la competencia en `competitor_unit_observations`, para que las sugerencias futuras (espera entre cambios, tendencia, efecto de los cambios) salgan de datos reales.

## Vigilancia de las tareas programadas (2026-10-07, #630)

`CronMonitorModule` (cargado por `QueuesModule` en el API y en el worker) recorre los `@Cron` registrados al arrancar y, con `job.addCallback`, anota cada ejecución y la siguiente prevista en `cron_heartbeats`, sin tocar cada cron. El proceso se identifica con `APP_PROCESS` (el worker lo fija solo). Una tarea cuya ejecución prevista pasó hace más de 15 minutos sale como atrasada en el panel admin.

## Emisor por propietario (plan Administrador, 2026-10-07/08, #647–#653)

Con la funcionalidad `multi_owner`, cada local puede pertenecer a un propietario y sus facturas las **emite el propietario**, no el tenant:

- El contrato copia el propietario del local al crearse; la factura, del contrato. Recargos, justificantes de fianza y rectificativas heredan el de su factura.
- Cada propietario tiene **sus propias series** (`P1`, `RP1`…), creadas solas, y **su propia cadena Veri\*Factu** (bloqueo y secuencia por emisor).
- Se envía con el certificado del propietario si lo subió; si no, con el del tenant como **representante** (`<Representante>` en la cabecera).
- Las facturas de propietarios se emiten **siempre en la app** (aunque el tenant use Holded) y no van a su copia contable.
- Los informes fiscales y las exportaciones se filtran por emisor (`?ownerId=`).

## Retención de IRPF sin tocar los cálculos de pendiente (2026-10-07, #646)

Al emitir una factura con retención se registra un pago `withholding` no monetario por el importe retenido. Así, todo lo que calcula «lo que falta por cobrar» (remesas, pasarelas, recordatorios, portal) ya descuenta la retención sin cambiar ninguno de esos cálculos. Lo que mide dinero real (caja, cobrado, reembolsos, Holded, exportaciones) excluye los métodos no monetarios (`NON_CASH_PAYMENT_METHODS`: `credit_note` y `withholding`).

## Web de TrasterOS gestionada desde el panel (2026-10-08, #649, #654–#656)

La portada pública (`apps/web/src/app/(public)/page.tsx`) lee en el servidor, con caché de 60 s, la oferta fundador y los ajustes de la web (logo, formulario de contacto y pie) de tablas globales de un solo registro. Si la API no responde, se pinta lo de por defecto (sin oferta, logo de la marca, pie de `DEFAULT_PLATFORM_FOOTER`). El menú de secciones vive en `apps/web/src/components/public/site-nav.ts`. El logo no admite SVG (se sirve desde el mismo sitio que la app y podría llevar scripts) y los enlaces del pie se validan (solo rutas, anclas, `https://`, `mailto:` y `tel:`).

## Web del tenant en el dominio propio (2026-10-13/14, #665–#667)

Las direcciones «bonitas» (`/reservar/<centro>`, `/precios`, `/contacto`, `/<local>`) existen **solo en el dominio propio verificado**: el middleware de Next las reescribe a las rutas internas (`/book/<slug>`, `/s/<slug>/precios`…) y marca la petición con la cabecera del tenant; fuera del dominio propio `/precios` y `/contacto` dan 404 para no duplicar contenido en trasteros.pro. Los enlaces de reserva son absolutos al dominio propio para que funcionen también desde `trasteros.pro/s/<tenant>`. Los títulos de las webs de los tenants no llevan «TrasterOS» (`title.absolute`).

## WhatsApp Business del tenant (2026-10-14/15, #668–#673)

- **Un webhook para toda la app de Meta**: el mensaje se asigna al tenant por el `phone_number_id` del número de destino (único global), nunca por el remitente. Un número de tenant nunca cae al flujo del número de la plataforma, aunque tenga el extra apagado.
- **Credenciales por tenant** (token cifrado) y cliente sin SDK con modo simulado, como el resto de pasarelas.
- **IA separada de la del panel**: la plataforma configura su IA de WhatsApp (proveedor, modelo, clave, límite mensual por respuesta); cada tenant usa la de TrasterOS o su propia clave (lo decide el super admin). Pasado el límite se usa la clave propia si existe; si no, contesta el equipo y se avisa. Todas las llamadas al proveedor van por `safePostJson` (la URL puede ponerla el tenant).
- **Sin tool-calling**: el asistente recibe el contexto de la web (locales con códigos `[L1]`, tamaños `[L1-T2]`, precios con IVA, disponibilidad, promoción, preguntas frecuentes) y devuelve marcas de texto que el servidor interpreta y quita: `[[HUMANO]]` (pasa a una persona y se pausa), `[[RESERVA {json}]]` (se valida con `PublicBookingSchema` y se crea la reserva online de siempre, con el trastero retenido 72 h) e `[[IDIOMA xx]]` (idioma del cliente para los textos fijos). Así funciona con cualquier proveedor.
- **El equipo manda**: si responde una persona, el asistente se pausa en esa conversación. La primera respuesta del asistente lleva un aviso fijo de IA (lo añade el servidor).
- **Recordatorio de reservas**: el de WhatsApp y el del correo comparten la misma reserva atómica (`contracts.booking_reminder_sent_at`), porque cada uno genera un enlace de firma nuevo; si WhatsApp no puede (ventana cerrada y sin plantilla), lo manda el correo.
- **Archivos**: se descargan de Meta en segundo plano (solo de sus dominios, ≤20 MB) al bucket privado; se envían subiéndolos a Meta por multipart (no se expone MinIO a Meta). Anonimizar y la retención borran también los archivos.
- Pendiente: alta con coexistencia (Embedded Signup) cuando Meta apruebe a TrasterOS como Tech Provider.

## Asistente IA: clave, límite de consultas y clave propia del tenant (2026-10-29, #866–#868)

- **De dónde sale la IA**: la clave y el modelo se guardan en el panel admin (`platform_ai_settings`, clave cifrada); sin ellos, las variables de entorno (`ANTHROPIC_API_KEY` con `AI_PROVIDER=anthropic`, `AI_MODEL`); sin nada, modo de demostración. `PlatformAiSettingsService` los guarda en memoria y los relee cada minuto; `DelegatingAiProvider` elige en cada llamada (en tests, siempre el de demostración).
- **Una consulta = una pregunta**, no cada llamada al modelo. `AiQuotaService.reserve` la reserva **antes** de llamar, dentro de una transacción con `pg_advisory_xact_lock` por tenant (dos preguntas a la vez no se cuelan en la última) y crea la fila `ai_usage_events` con `counts_as_query`; las llamadas guardan solo los tokens. Si la llamada falla, `release` borra la reserva.
- **Límites**: al mes por tenant (el general + las consultas de los extras, o el propio que ponga el super admin), al día por usuario del equipo y al día por inquilino del área de clientes. El día se corta en la zona horaria del tenant; el mes, en la de Madrid. Avisos al 80 % y al 100 % (campana; al 100 %, también correo a los propietarios), uno por nivel y mes.
- **Clave propia del tenant** (cifrada con AAD = tenant): en modo `platform`, al gastar un límite se sigue con ella en vez de cortar; en modo `own` (lo decide el super admin), siempre. Esas consultas llevan `own_key` y no cuentan para el límite ni para el coste. `AiService` fija el proveedor de cada pregunta con un `AsyncLocalStorage`, así todas sus llamadas (herramientas y streaming incluidos) usan la misma clave.

## Vaciar los datos de prueba de un tenant (2026-10-29, #865, #867, #868)

- Solo super admin, con el identificador del tenant escrito y la exportación confirmada. Bloquea si hay facturas aceptadas por la AEAT (en producción, cualquiera enviada) o emitidas en Holded.
- Antes de borrar, quita los accesos de los inquilinos de los terminales de las puertas (Dahua): si queda alguno, no borra nada (409).
- Borra en una transacción, en un orden que respeta las claves ajenas (`PURGE_STEPS`), y después los ficheros por prefijo (la misma lista sirve para la vista previa). Conserva locales, trasteros, productos, contactos, usuarios y configuración; las series vuelven a 1. Aviso en el panel admin y resumen al email de alertas.

## Chat con IA en la web del tenant (2026-10-29, #872–#874)

- **Solo información pública**: el contexto sale de `landing/public-business-context.ts` (el mismo que usa WhatsApp), las preguntas frecuentes y las indicaciones del tenant. No tiene herramientas ni acceso a datos de inquilinos.
- **Cuota aparte de la del panel**: `AiQuotaService.reserveWeb`, con modelo y límites propios en `platform_ai_settings`, tope por visitante y día, y 10 mensajes por minuto e IP. Al gastarla sigue con la clave del tenant o responde sin IA (`fallback`), y esas respuestas no cuentan como del asistente.
- **Acciones con marcas de texto**, como en WhatsApp: `[[CONTACTO …]]`, `[[RESERVA …]]`, `[[ESPERA …]]`, `[[HUMANO]]` y `[[SIN_RESPUESTA]]`. El servidor las valida y las quita; en streaming, `MarkerStreamFilter` retiene el texto desde `[[`.
- **Paso a una persona**: `mode=human` calla a la IA y el widget sondea cada 10 s.
- **Caché de prompts de Anthropic** en los tres asistentes: `AiSystemPrompt = {stable, dynamic}` (reglas y negocio con `cache_control`, la fecha aparte).

## Asistente del panel con todo el negocio (2026-10-29, #872)

`AiBusinessTools` da búsqueda, ficha y listas de 19 tipos de registro. Cada tipo exige su permiso: el enum del esquema solo lista los permitidos. Respeta el alcance por local y todo va con `withTenant`.

## Métricas del negocio con una sola definición (2026-10-29, #861–#862)

`common/saas-metrics.ts` fija quién está vivo, quién paga, qué es una baja y el cobrado neto (`LIVE_TENANT_WHERE`, `PAYING_SUBSCRIPTION_WHERE`, `churnedBetweenWhere`, `netPaid`). Métricas, Finanzas, LTV y snapshots usan estas definiciones: no redefinirlas en cada consulta. `tenants.trial_ended_at` lo pone un disparador de Postgres, para que cualquier salida de la prueba quede registrada.

## Cobros de la suscripción: fechas y deuda (2026-10-30, #879–#880)

`billing-saas/platform-due.ts` calcula la fecha debida (`subscriptionDueDate`), las cuotas vencidas (`periodsOwed`) y los meses sin saltos a fin de mes (`addMonthsUtc`). Lo usan el escalado, Cobros pendientes y el estado de cuenta. Lo que va en una remesa SEPA no suma como pendiente, y un cobro de Redsys `charging` no escala.

## Web del tenant: cabecera común, landings y blog (2026-10-30 → 11-03, #876, #883–#884, #890–#891)

- **`TenantSiteChrome`**: blog, fichas de local, ciudades, legales y landings llevan la cabecera y el pie de la portada. `TenantWebChrome` queda como respaldo.
- **Landings de promoción**: el contenido va en `promo_landings.content` (jsonb) y `parsePromoLandingContent` completa lo que falte. Los botones tienen acción tipada, nunca una dirección. Se piden sin caché porque Next solo cachea respuestas 200 y apagar una landing no se notaría.
- **Blog**: enlaces `web:<destino>` y bloques en línea propia (`[[boton]]`, `[[calculadora]]`, `[[tamanos]]`, `[[locales]]`, `[[comparativa]]`), que parte `splitBlogContent`. Un bloque mal escrito queda como texto.

## Comunicación de la plataforma (2026-11-02/03, #885–#888)

- `renderAdminEmail` (shared) escapa siempre el texto y aplica la marca de TrasterOS. El nombre de un tenant nunca entra sin escapar en un correo.
- `AdminSegmentService` resuelve a quién va un anuncio. `deliverAnnouncement` rellena las variables por destinatario y respeta la baja en los comerciales.
- Si el correo directo no sale, no se guarda nada (502 `email_send_failed`): el tenant no ve un mensaje que no recibió.

## Seguridad del panel admin (2026-11-04, #892–#893)

- **Cerrar sesión de verdad**: `tokens_valid_after` lo comprueba `AdminGuard` en cada petición, porque el access token dura 8 h.
- **Rastro**: los fallos de entrada y de 2FA son eventos de seguridad y cuentan para la fuerza bruta.
- **Avisos sin repetir**: `claimAlert` (`admin/alert-state.ts`) reserva cada aviso en BD, así que no se duplica entre réplicas ni al reiniciar. Lo comparten las alertas de seguridad, del sistema y de «Hoy».
- **Bloqueos**: `SecurityBlocksService.assertAllowed` da el mismo error que una contraseña mala. Nunca se bloquea la IP propia ni a un super admin.
- **Impersonación**: `ImpersonationContextInterceptor` marca cada acción auditada con su sesión.

## Bandejas «Hoy» (2026-11-04/05, #895–#898)

- **Urgente = lo que vence hoy o está atrasado y se puede hacer hoy**. Lo que tiene días por delante va a «Esta semana». La deuda cuenta una vez por inquilino y no cuenta con un cobro en curso ni con plan de pagos.
- **Un solo criterio de vencido**: `overdueInvoiceWhere` (`dashboard/today-filters.ts`) en la bandeja y en las cifras; en el admin, `AdminBillingOpsService.receivables`.
- **Permisos por apartado**: `TodayService.getToday` recibe `permissions` y cada bloque exige su lectura, también en el correo del resumen.
- **Extras aparte**: `TodayExtrasService` (`GET /dashboard/today/extras`) para no frenar la bandeja principal.
- **Apartar** (`today_snoozes`, `admin_today_snoozes`): lo apartado no sale ni cuenta, y se comparte con todo el equipo.
- **Resumen del día**: se reserva por persona (`users.daily_summary_last_date`).

## Imágenes compiladas fuera del servidor (2026-11-12, #941)

- El servidor (VPS de 4 GB) no compila: GitHub Actions (`images.yml`) construye `api`, `worker` y `web` en cada push a `main` y las publica en GHCR (`latest` y `sha-<commit>`); Portainer las descarga (`pull_policy: always`). Compilar cinco imágenes a la vez en el servidor lo dejó sin memoria el 12-11.
- La web hornea sus URL públicas desde las variables del repositorio. Una variable `NEXT_PUBLIC_*` nueva necesita su variable y su `build_args`.
- En la CI, `nest build` y la comprobación de tipos llevan `--max-old-space-size=4096`: con el límite por defecto de Node se quedaban sin memoria (exit 134).

## Lo que se cobra y se emite cuando entra el dinero (2026-11-12/13, #942, #946)

- La primera factura de una reserva online, o de un contrato del panel firmado por enlace, es un borrador `issue_on_payment`: se emite (número, fecha y Veri\*Factu) al cobrarse. Si no se paga en plazo, se anula sin número ni rectificativa.
- Lo mismo con la señal de una reserva y con la tienda y el pase nocturno del área de clientes.
- El justificante de fianza que va con ese pago espera como borrador y pasa a cobrable cuando se emite la factura.
- `PAYABLE_INVOICE_WHERE` es el único criterio de «se puede pagar» en el portal, los recordatorios, «Hoy» y la caducidad.

## Documentos que firma el inquilino (2026-11-13/14, #949–#951)

- **Contrato**: el texto lo arma `composeContractTerms` (cabecera con partes y cifras, condiciones generales o del tenant, condiciones específicas del contrato, reserva anticipada, formulario de desistimiento y consentimiento). Se congela al firmar (`signed_terms_text`) con su huella.
- **Anexos** (`contract_annexes`): lo firmado no se cambia. El anexo congela su texto al crearlo, toma las partes de la cabecera del contrato firmado y se firma con un enlace propio (`/sign/annex/<token>`), con la misma evidencia que el contrato.
- **Enlaces**: los de firma son de un uso de verdad. Pedir uno nuevo, desde el panel o desde el área de clientes («Pendiente de firmar»), invalida el anterior, así que el correo viejo deja de valer.

## Cartera: subidas y renovaciones (2026-11-14, #952–#953)

- **Las cuotas cambian antes de facturar**: `contracts.scheduled-changes` (00:05 de Madrid) y `rent-increases.apply` (00:10) aplican los cambios del día y la facturación (02:00 UTC) usa la cuota vigente ese día. Antes iban después y la subida se cobraba un mes tarde.
- **Subidas siempre un día 1**, con preaviso mínimo configurable (30 días) y aviso si es la segunda del año; fuera las viviendas y los contratos con la baja pedida. «No subir hasta…» por contrato vale también para la actualización anual (`AnniversaryUpdatesService`).
- **Renovar con oferta**: la oferta de renovación se firma como anexo del contrato (`ContractAnnexesService.sign`) y se aplica sola al firmarse.

## Operaciones diarias (2026-11-14, #954–#955)

- **Módulo aparte `daily-ops`** (gasto de una tarea o incidencia, responder al inquilino, tarea de reparación, vencimiento → tarea): Gastos importa la IA y la IA importa Operaciones, así que meterlo en Operaciones creaba un ciclo de módulos.
- **Incidencias**: el inquilino ve las suyas y las marcadas «visible para el inquilino» (`incidents.visible_to_customer`), nunca las notas internas.
- **Calendario con permiso por tipo de evento**; el mantenimiento empieza desde hoy sin generar atrasos.

## Contactos del negocio (2026-11-15, #956–#958)

- **La reserva online gana el contacto al firmar** y lo devuelve a abierto si caduca; el contacto conserva su primer origen. Responder por correo vuelve a su ficha con una dirección propia (`leads.reply_token`).
- **Tablas con `customer_id` o `lead_id`**: toda tabla nueva con `customer_id` va en `CUSTOMER_REFERENCES` (o `_WITH_UNIQUE`), y la fusión de contactos y `anonymizeLeadsTx` deben mover o borrar cualquier tabla nueva con `lead_id`.
- **Ampliar el plazo para firmar y pagar** (`PaymentDeadlineService`): como mucho 30 días desde la reserva o la firma; el trastero sigue reservado y el correo de aviso cuenta como recordatorio.

## Campañas y Comunicaciones (2026-11-16, #959–#960)

- **Textos comprobados al guardar** (`assertTemplateTexts`, 400 `invalid_template_text`): una variable mal escrita ya no deja una campaña «Enviada · 0».
- **Alcance por local**: `communicationScopeWhere` en Comunicaciones; `campaigns.facility_scope` limita la audiencia; el win-back es de toda la empresa.
- **Historial sin secretos**: los enlaces con acceso se guardan tapados; el correo sale completo.
- **Programadas**: la audiencia se decide al salir (`dispatchScheduled`, tarea `campaigns.resume`). Los envíos atascados se vuelven a encolar (`communications.requeue-stuck`, worker) y las automáticas salen con `campaigns.automations` (09:30, API), una por destinatario y periodo.
- **La baja de las comunicaciones comerciales es por email**: vale para todas las fichas con esa dirección.

## Fianzas con servicio (2026-11-16, #961)

- Al liquidar la fianza, la parte que paga un servicio del negocio se factura con IVA (`issueDepositServiceInvoice`) **antes** de reclamar la fianza: si la factura falla, el borrador se anula sin número y la fianza no se toca. Los daños se retienen sin factura hasta que la asesoría confirme el criterio.

## Fidelización (2026-11-16, #962–#963)

- **La recompensa del referido se gana con el primer pago del recomendado** (`ReferralsService.onInvoicePaid`, reserva atómica), no al firmar: una reserva online se firma sin pagar y caduca sola.
- **La web solo anuncia lo marcado** (`announce_on_web`) y la reserva online acepta ese código.
- **Descuentos con fecha de fin**: el repaso diario devuelve el precio al caducar, y la factura mensual no aplica un descuento cuya fecha de fin no pasa del inicio del periodo (la facturación corre antes que el repaso).

## Primer pago pendiente (2026-11-16, #964–#965)

- Al firmar por enlace, el correo `first_payment_pending` (desglose, total, plazo y «Pagar ahora») sustituye al de contrato firmado; el enlace de firma vale hasta el plazo.
- El PDF del primer pago, sin número, se descarga con el mismo enlace sin sesión que las facturas; una vez pagado, ese enlace descarga la factura emitida. Reenviarlo desde el panel genera un enlace nuevo y anula el anterior.

## Marketing del tenant (2026-11-16, #966–#968)

- **Propiedad comprobada**: la cuenta de servicio de Google es la misma para todos, así que una propiedad de Analytics solo se conecta si mide la web del negocio (su ID de medición, Admin API) y solo puede estar en un negocio; Search Console, solo el dominio propio verificado o `/s/<slug>/`.
- **Secretos fuera**: los enlaces de firma, invitación y contraseña nunca llegan a Google Analytics; el token de Meta va en cabecera y Sentry no guarda tokens.
- **Un contacto, un canal** (`marketing/attribution.ts`): el contacto guarda el canal con el que llegó y los informes lo usan antes que el origen; Google Ads y Meta solo cuentan el tráfico de sus anuncios.
- **Dinero y alcance por permisos** (`marketingViewer`): sin permiso de gastos no hay costes; sin facturas y cobros no hay ingresos; quien ve unos locales ve sus canales y contactos.
- **Visitas ya sumadas** (`web_visits`, `web_page_daily`): los informes no recorren los eventos crudos.
- **Conversiones a Google Ads y Meta** (`marketing.ad-conversions`, cada 30 minutos, worker): solo con «Aceptar todas» las cookies; una vez por contrato y plataforma.

## Equipo comercial (2026-11-16, #969)

- **Rol denegado por defecto**: `AdminGuard` deja al rol `sales` solo lo que lleva `@SalesAccess()` (403 `sales_not_allowed`) y le exige la verificación en dos pasos desde el primer día. Un endpoint nuevo del panel que deba usar un comercial necesita ese decorador.
- **Cartera aislada**: todo `/admin/sales/*` se limita a las cuentas del comercial (otra → 404); nunca ve inquilinos ni facturación de sus clientes ni entra en sus cuentas. La dirección tiene `/admin/sales-team/*` (superadmin).
- **Quién es de quién**: el enlace o QR, el código escrito o la cuenta creada por el comercial; sin código no se asigna a nadie. `sales_assignments` guarda el historial y la comisión de un cobro es del comercial que llevaba la cuenta ese día.
- **Avisos personales**: `super_admin_notifications.recipient_id`; el push se reparte por destinatario y el feed común del admin solo muestra los avisos sin destinatario.
- **Comisiones** (`sales.hourly`): cada cobro se reparte entre plan y extras por sus líneas (`commission-split.ts`), sin IVA y menos lo devuelto; solo cuentan los extras de la venta o aprobados por la dirección; las devoluciones posteriores restan.
- **Propuestas con seguimiento**: el enlace del correo pasa por `/v1/public/offers/:id/open` con firma HMAC, anota la apertura y avisa; caducan a los 15 días.
- **Correo con el nombre del comercial**: `EmailService` admite `fromName` y `replyTo` para sus propuestas y, si la dirección lo deja activado, los correos automáticos de sus clientes.

## Equipo comercial: revisión, funcionalidades y citas (2026-11-17/18, #970–#972, #976–#978)

- **Comisión congelada por cobro**: la primera partida de cada cobro guarda el reparto entre plan y extras (`split`); los recálculos solo lo escalan por lo devuelto, así que cambiar los extras después no toca cobros anteriores.
- **Ventas** (`sales_wins`): el primer pago de cada cliente de comercial; cuentan para objetivos, tramos y bonus, y desaparecen si se devuelve todo.
- **Leads del admin**: asignar un lead a un comercial desde el panel admin pasa por `SalesAssignmentService.assign` (cartera, historial y aviso), igual que los de la web.
- **Citas** (`sales.appointments`, cada 5 min en el API): recordatorios del día antes y una hora antes, reservados fila a fila con `updateMany`.

## Planes por trastero y prueba (2026-11-18, #973–#975)

- **Trasteros de más** como extra interno (`is_system`): se cuentan justo antes de cada cobro (remesa SEPA, Redsys, Stripe sin prorrateo) y van siempre con la cuota, sin tocar el MRR ni los cargos sueltos.
- **Solo lectura** (`TenantStatusGuard`, 403 `subscription_expired_read_only`): al acabar la prueba o el plan gratis sin pagar. Inquilinos, web pública y cobros siguen funcionando; a los 30 días se suspende.
- **Precio a medida**: al llegar al tope de Pro o Administrador, `PlanLimitsService.flagCustomPricing` crea un seguimiento y un aviso, una vez mientras siga pendiente.

## Primer pago en un solo cobro (2026-11-18, #979)

- La factura del primer pago y su fianza se cobran juntas en todas las vías (enlace de la firma, área de clientes, Redsys, transferencia, recordatorios y «Registrar cobro» con «Incluye la fianza»): un solo «Pago recibido» con el total.

## Analítica (2026-11-19, #980–#981)

- **Una definición por cifra**: `AnalyticsScope` lleva el emisor (`?ownerId=`, propietarios aparte como en Fiscalidad) y deja fuera los locales por abrir; `monthlyFee` es la cuota con descuento y prepago; el cobrado no cuenta la fianza aplicada.
- **Dinero con permisos**: las cifras de dinero exigen `invoices:read` y `payments:read`; sin ellos salen a `null`.
- **`AnalyticsExtrasService`**: resumen del mes, deuda por inquilino y local, cartera por debajo del precio, rendimiento por tipo, cuotas que entran y salen, escenarios de la previsión e informe «Resumen del mes» en PDF.

## Mercado (2026-11-19, #982–#983)

- **Precio comparable único** (`competitorComparablePrice` en `pricing-engine.ts`): lo que paga de media un cliente de la competencia el primer año, sin IVA, con su seguro, alta y la promoción solo mientras dure. Lo usan la sugerencia de precio, los avisos, la ficha de cada trastero y «Tu precio frente al mercado».
- **Ocupación de la competencia** solo con inventarios completos y comprobados en 180 días; la del total conocido sale aparte como estimada.
- **Search Console**: se guardan los totales de cada día y por dispositivo además de las búsquedas, para cuadrar con el panel de Google y comparar con el año pasado. Un fallo pasajero de Google no cambia el estado a «sin acceso»; la descarga diaria repasa desde la última buena.
- **IA para leer tarifas** (`CompetitorsMarketService.aiParse`): propone, nunca guarda; el usuario revisa y aplica.

## Informes y asistente IA programados (2026-11-19)

- `report_schedules` y `ai_scheduled_questions` se reclaman por `next_run_at` desde un cron del worker; cada ejecución avanza la fecha antes de generar, para no repetir entre réplicas. Los informes respetan el alcance por local de quien los creó (`report_runs.facility_scope`).

## Configuración, Novedades, Cómo funciona y Soporte (2026-11-20/21, #995–#998)

- **Acceso a cada página del panel**: `lib/navigation/route-access.ts` (`routeRequirements`, `useRouteAccess`) dice qué permiso y función pide cada ruta; el menú, el buscador y la ayuda lo usan. Al añadir una sección con permiso o función hay que darla de alta ahí.
- **Guías de ayuda**: viven en `packages/shared/src/help/` y el super admin las cambia o añade desde `/admin/help-topics` (`platform_help_topics` guarda solo lo cambiado); cada página enlaza sus guías (`lib/help/route-guides.ts`).
- **Soporte**: antes de abrir un ticket se intenta responder con el asistente (`ai_answer`); el estado del servicio (`platform_service_status`) se enseña a todos los tenants.

## Trasteros cedidos (2026-11-21, #999–#1001)

- Función `unit_cession` fuera de todos los planes: solo por override del super admin. Solo el propietario (403 `owner_only`).
- Un trastero cedido (`ceded`) no factura ni entra en cifras de ocupación o ingresos (cuenta como fuera de servicio). No se libera solo al vencer: avisa al propietario y hay que cambiarlo a mano.
- Código de acceso sin inquilino (`metadata.source = 'unit_cession'`), nunca enviado por correo, salta el toque de queda.
- Un mismo candado por trastero (`pg_advisory_xact_lock(hashtext(tenant), hashtext(unit))`) en cesión, reservas, alta de contrato y reserva online, para que no se pisen.

## «Hoy» del super admin (2026-11-21/22, #1002–#1003)

- `getToday` reúne unas 30 consultas, cada una envuelta en `safe()` (si una falla, sale en `failedSections` y el resto carga) y se guarda 30 s en memoria; el contador del menú (`GET /admin/today/count`) y el aviso inmediato usan esa copia, la página pide datos frescos.
- **Urgencia en un solo sitio**: `adminTodayUrgentCounts` (shared) la usan el servidor y las pestañas, para que siempre cuadren.
- **Apartados con huella** (`today-fingerprint.ts`): si el aviso empeora, vuelve con el motivo.
- **Aviso inmediato** sin repetirse por lo mismo: el identificador lleva el estado (`claimAlert`, `alertSentWithin`, `markAlertSent`).

## Panel super admin: cifras y vigilancias (2026-11-22/26, #1005–#1020)

- **MRR sin IVA, una sola definición** (`common/saas-metrics.ts`): `tenantMrr`/`currentMrrByTenant` lo usan Métricas, las fotos mensuales, la ficha de negocio, «Hoy» y la lista de tenants. El anual cuenta entre 12 (salvo SEPA y Redsys, que cobran la mensual), con el descuento del último pago y los extras; las fotos antiguas se pasaron a sin IVA (`20270223100000`). Un pago atrasado sigue en el MRR hasta suspender y la prueba que acaba sin pagar no es cliente ni baja (decisiones de Jota).
- **Salud solo de quien paga por defecto**: `GET /admin/tenants/health?segment=paying|trial|unpaid|exempt`; las pruebas se miden aparte con su activación (local, trasteros, inquilino, contrato firmado, factura, equipo) y los factores que no aplican reparten su peso. La actividad del equipo sale de un solo sitio (`lastTeamActivityByTenant`: el más reciente entre `last_login_at` y `sessions.last_used_at`). Consultar no escribe: la foto del mes y la diaria las guarda `tenant-health.daily-snapshot` (worker).
- **Un solo criterio de «problema de AEAT»** (`aeatProblemWhere`, `aeat-problems.ts`): lo usan el resumen, la lista, «Hoy» y los conteos; los registros que nunca llegan a enviarse cuentan, y fuera tenants borrados, cancelados, con Veri\*Factu apagado o simulado y quien emite en Holded.
- **Una sola vigilancia de dominios propios** (`custom-domains.full-check`): DNS, https y certificado en una pasada y un solo aviso por episodio. Un dominio cuyo plan ya no incluye la función queda «En pausa» (`reconcileCustomDomainPause`: `custom_domain_verified_at` a nulo y la fecha en `custom_domain_paused_verified_at`), así los ~40 sitios que construyen enlaces con `customDomainVerifiedAt` vuelven solos a la plataforma. **Regla**: un sitio nuevo que construya enlaces con el dominio propio mira solo `customDomainVerifiedAt`.
- **Cartera aislada y reasignación**: reasignar un lead mueve también la cartera del comercial, salvo que ya sea cliente suyo. Archivado = perdido con `sales_archived_at`; un archivado con fecha de recuperación o «no volver a contactar» no se libera por inactividad (`staleWhere`). Lo que hace la dirección queda como actividad `direction`, que no cuenta como contacto ni como última actividad. Un cliente recuperado paga la mitad (`SALES_RECOVERY_COMMISSION_FACTOR` 0,5: mitad del % y mitad del fijo por venta).
- **CSV del panel admin**: todo texto de usuario pasa por `csvCell` (`common/csv.ts`), que antepone `'` a `= + - @`.
- **Cerrar sesiones de verdad**: `users.tokens_valid_after` y `SessionsService.revokeAllForUser` hacen que un acceso anterior se rechace (401 `session_revoked`), salvo impersonación.

## SEO Avanzado (2026-11-26, #1021–#1032)

Plan completo en `docs/SEO_PLAN.md`.

- **Un motor, dos ámbitos**: proyectos de la plataforma (`tenant_id` nulo, panel admin → SEO) y uno por tenant con el extra «SEO Avanzado» (`seo_advanced`, fuera de los planes, incluye «SEO local» vía `INCLUDED_FEATURES`). Las tablas llevan `tenant_id` y RLS; un `tenant_id` nulo nunca cumple la política, así que el rol de la app no ve lo de la plataforma, que se lee con la conexión de administración. El módulo se parte en `SeoAdvancedModule` (núcleo: descargas, tandas, cálculos y crons; también en el worker) y `SeoAdvancedHttpModule` (rutas, panel, importaciones, OAuth y alertas; solo API), de modo que el worker no necesita jszip ni papaparse.
- **«Fondo» de datos de SISTRIX**: lo que se pide a SISTRIX queda en tablas con el `tenant_id` de la conexión con que se pidió (nulo = la plataforma); dos proyectos del mismo fondo comparten caché y datos, y lo de la cuenta de la plataforma no llega a otro tenant salvo «Usar la conexión de SISTRIX de la plataforma» (solo superadmin; pensado para negocios propios como GUÁRDALO).
- **Proveedores con enrutador** (`seo-provider-router.ts`, función pura): `gsc`, `sistrix_mcp`, `sistrix_api` y `manual_import`, y cada dato guarda de cuál vino. Plataforma: MCP si está conectado y con cuota → API clásica solo con «Continuar por API» autorizado, activada y con presupuesto → si no, esperar con el motivo (se reanuda a las 00:05 de Madrid tras el error 7010). **Por qué los tenants solo con su clave**: las condiciones de SISTRIX prohíben ceder sus datos a terceros sin autorización escrita y el MCP aplica la misma política; sin clave, un tenant tiene todo lo que sale de Search Console y lo de SISTRIX aparece como «conecta tu cuenta». El canje del código OAuth va sin `redirect_uri` (SISTRIX lo rechaza) y el refresh **rota**, así que se renueva con `pg_advisory_xact_lock`. **Regla**: nunca llamar a `project*`, `ai_tracker*` ni `ai_topicresearch` vista `list`; el país va siempre explícito.
- **Colas y crons aparte**: `seo` (Search Console, oportunidades, inspección, PageSpeed, GA4; concurrencia 2), `seo-sistrix` (concurrencia 1, con pausa entre llamadas, para no mezclar cuota ni bloquear la descarga de Google) y `seo-crawl` (concurrencia 2, un rastreo vivo por proyecto). Una ejecución viva por dominio y tipo (índices parciales); lo que queda a medias se reanuda al arrancar el worker. Cada recálculo (oportunidades, canibalización, indexación) corre en un único job `opportunities` por proyecto, a los 60 s de terminar una descarga.
- **Oportunidades, canibalización e indexación son tablas distintas** y con el mismo ciclo de vida: clave estable `sha1`, recalcular no pisa estado ni notas, y lo arreglado que Google vuelve a enseñar sale como nuevo. Lo puro (puntuación, reglas, ventanas del antes y después) vive en `packages/shared/src/seo/` con vitest. El antes y después de una actuación no se guarda: se calcula al leer desde `seo_gsc_metrics` (ventanas simétricas de 7/28/90 días con 3 días de margen; «coincide con», nunca «gracias a»).
- **El rastreador hace solo GET seguros**: peticiones HTTP sin navegador, solo a hosts del proyecto, con la IP validada al conectar en cada salto (nada privado, de loopback ni de metadatos), 5 redirecciones, 3 MB y 15 s, una petición a la vez con pausa, y respetando el robots.txt. En pruebas solo sale a un servidor local. Agente `TrasterOS-SEO-Crawler/1.0` con página pública `/rastreador`.
- **Asistente de IA de solo lectura**: 11 herramientas de lectura sobre los servicios de las pantallas, con el dueño de quien pregunta y con origen y fecha en cada cifra. **El texto de fuera** (competencia, páginas rastreadas, respuestas de las IA, mensajes de Google) llega al modelo entre `⟦externo⟧ … ⟦/externo⟧`, sin control ni invisibles y sin poder cerrar el bloque (`seoUntrusted`), y el simulador de pruebas nunca lee el resultado de una herramienta. Lo que propone (tarea, actuación, oportunidad en curso, seguir una palabra) son acciones que se ejecutan **al confirmar**, una vez, y caducan a 7 días. Pasar un brief a borrador crea la entrada del blog **sin publicar**. Reutiliza `AiService.runToolLoop` (con `tenantId` nulo usa la clave de la plataforma y `platform_ai_usage_events`); en los tenants gasta del límite mensual de IA o de su clave propia.
- **Google sin duplicar**: la inspección de URL usa el ámbito de solo lectura de Search Console (la documentación lo admite) y su cuota se cuenta por día del Pacífico con tope propio; GA4 reutiliza el `Ga4Client`, la cuenta de servicio y, en un tenant, la propiedad ya comprobada de Marketing, pero con tabla propia (`seo_ga4_landing_daily`) porque `ga4_page_rows` no tiene canal ni página de entrada. Ninguna propiedad se comparte entre dueños (409 `seo_ga4_property_taken`).
- **Una sola alerta o informe por tema**: con SEO Avanzado, su informe mensual sustituye al de «SEO local» y su alerta de clics al aviso de caída (`seo-advanced-overlap.ts`). Las alertas corren cada hora en el API porque los avisos de la plataforma salen del panel admin (Telegram y Slack); los informes llevan un enlace firmado de 7 días porque el correo no admite adjuntos.
