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

## Seguridad: defensa en profundidad

- **Red:** firewall del VPS solo abre 80/443; el resto, red Docker interna.
- **App:** rate limiting, validación estricta, CORS configurado, Helmet.
- **Auth:** JWT corto + refresh en httpOnly cookie, 2FA para roles sensibles.
- **BBDD:** RLS por tenant_id, usuario Postgres de la app sin permisos DDL.
- **Secretos:** nunca en repo, gestionados como variables de entorno y montados como Docker secrets en prod.
- **Backups:** cifrados con gpg antes de subir a almacenamiento externo.
