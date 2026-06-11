# 044. Compliance + observabilidad post-MVP (Fase 11)

- Fecha: 2026-05-20
- Estado: aceptada
- Fase: 11 (compliance + observabilidad post-MVP)
- Reemplaza/amplía: ADR-008 (Veri\*Factu real client), ADR-039 (Super admin con auth separada)

## Contexto

Tras cerrar Fase 10 el MVP está completo: emite facturas conformes a Veri\*Factu real contra el endpoint AEAT, panel super admin con 2FA, certificado por tenant, cola con retry. Antes de salir a vender a clientes reales detectamos cuatro brechas que conviene cerrar en el mismo bloque (todas son hardening, no funcionalidad nueva):

1. **Sin persistencia de eventos de seguridad sin tenant context**. Los `login_failed` cuando el slug del tenant o el email no existen no van a `audit_logs` (su FK `tenant_id` es `NOT NULL`); solo quedan en el logger Pino. No podemos auditar ataques de credential stuffing entre tenants ni montar alertas a partir de la BD.
2. **Sin trazabilidad histórica de rotaciones del certificado AEAT por tenant**. `tenant_aeat_credentials` tenía UNIQUE sobre `tenant_id`, así que al rotar el cert perdíamos el anterior (upsert sobrescribe). Para inspecciones AEAT o disputas con un PSC hace falta poder reconstruir qué certificado estaba activo en qué fecha.
3. **Sin Content Security Policy en el frontend**. El panel `/dashboard` no tiene cabecera CSP. Un XSS por dependencia o por contenido user-generated puede exfiltrar tokens sin restricción.
4. **Sin soporte para facturas rectificativas**. Veri\*Factu obliga a poder corregir una factura emitida (descuentos posteriores, NIF erróneo, devolución parcial) con un `RegistroAlta` tipo R1–R5. Hasta ahora sólo emitíamos F1.

## Decisión

Se cierran en cinco sub-bloques (11A.1 a 11A.5) sin modificar funcionalidad de negocio existente: sólo se añade seguridad, trazabilidad y rectificativas.

### 1. Tabla global `security_events` separada de `audit_logs` (11A.1)

Nueva tabla **sin `tenant_id`**, escrita desde un `SecurityEventsService` invocado por `AuthService` y `SessionsService`. Persistimos:

- `login_failed_tenant_not_found` (slug inexistente),
- `login_failed_email_not_found` (email no existe en el tenant indicado),
- `login_failed_wrong_password`,
- `refresh_token_reuse` (un refresh ya rotado se vuelve a presentar; mismo evento que dispara el revoke paranoid).

Endpoint admin `GET /admin/security-events` con filtros (`eventType`, `email`, `fromDate`, `toDate`) y paginación cursor. Página `/admin/security-events` en el panel super admin para revisión. Cron diario `0 3 * * *` que borra eventos > 90 días.

### 2. `tenant_aeat_credentials` sin UNIQUE en `tenant_id` (11A.2)

Drop del UNIQUE; ahora la columna que identifica la credencial activa es `revoked_at IS NULL`. `TenantAeatCredentialsService.upload` en lugar de `upsert` ejecuta dentro de un `$transaction`:

1. `UPDATE` la fila activa actual (`revoked_at = NOW()`, `revoked_reason = 'rotated'`).
2. `INSERT` la nueva con `revoked_at = NULL`.

Nuevo `listHistory(tenantId)` ordenado por `uploaded_at DESC` + endpoint `GET /billing/aeat-credentials/history` (role `owner|manager`). UI colapsable en `/settings/billing/verifactu` con la lista histórica.

### 3. CSP `Report-Only` en el panel autenticado (11A.3)

Cabeceras CSP configuradas en `next.config.mjs` (modo `Content-Security-Policy-Report-Only` durante 1 mes para evitar romper el panel en producción; tras revisar reports se pasará a enforcement). Directivas:

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://js.stripe.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https:;
font-src 'self' data:;
connect-src 'self' https:;
frame-src 'self' https://js.stripe.com https://hooks.stripe.com;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
report-uri /api/csp-report;
```

Endpoint `POST /api/csp-report` que loggea las violaciones a Pino con `level=warn`. **Excepción para `/widget/:path*`**: el middleware mantiene `frame-ancestors *` + `X-Frame-Options: ALLOWALL` (sigue siendo iframe-friendly desde sites de tenants).

### 4. Rectificativas Veri\*Factu R1–R5 por diferencias (11A.4)

Schema: añadidos enum `InvoiceType` (F1, F2, R1, R2, R3, R4, R5) y `CorrectionMethod` (I = por diferencias, S = por sustitución). Columnas nuevas en `invoices`: `invoice_type` (default F1), `rectifies_invoice_id` (FK self), `rectification_reason`, `correction_method`.

`InvoicesService.rectify(originalId, args)` crea un draft con:

- `invoiceType` en R1–R5 según motivo (R1 error legal, R2 concurso, R3 deudas incobrables, R4 BORME, R5 simplificadas).
- `rectifiesInvoiceId` apuntando a la original.
- Items con importes negativos cuando aplique (corrección por diferencias).
- `correctionMethod='I'` por defecto (rectificación por diferencias, no por sustitución).

`VerifactuXmlBuilder.buildRegistroAlta` ahora detecta `invoiceType` ≥ R1 y añade `<TipoRectificativa>I</TipoRectificativa>` + bloque `<FacturasRectificadas>` con la `IDFactura` de la original. `RealAeatClient` carga la factura original via Prisma cuando la nueva tiene `rectifiesInvoiceId` para que el builder pueda referenciarla.

Endpoint `POST /invoices/:id/rectify` (role `owner|manager`). UI: botón "Rectificar" en `/invoices/[id]` (sólo si la original está `issued/paid/overdue`) + badge "Rectificativa" cuando la factura tiene `rectifiesInvoiceId`.

### 5. ADR + cierre (11A.5)

Este ADR + actualización de `ROADMAP.md`, `CLAUDE.md`, `README.md`, vault Obsidian.

## Alternativas rechazadas

1. **Tabla separada `tenant_aeat_credentials_history`** (vs quitar el UNIQUE) — duplica esquema, obliga a `INSERT` doble en cada rotación y rompe la simetría con la fila activa. Más simple: una única tabla con `revoked_at`. Es el mismo patrón que ya usábamos para `access_credentials` y `invitations`.
2. **CSP enforcement directo en producción** — riesgo alto de bloquear features que no detectamos en testing (Stripe Elements, MinIO presigned URLs, Recharts inline styles). `Report-Only` durante 1 mes nos da datos reales sin downtime. Pasar a enforcement es flip de header.
3. **Rectificación por sustitución (`correctionMethod='S'`)** — Veri\*Factu admite los dos métodos pero "por diferencias" (`I`) es el recomendado por AEAT y el único que la mayoría de software contable consume sin fricción. Sustitución queda disponible como opción en el DTO pero el default es `I`.
4. **Audit log a BD para `security_events`** (vs tabla dedicada) — `audit_logs` tiene `tenant_id NOT NULL` por diseño (todo lo que se loguea ahí pertenece a un tenant). Hacer `tenant_id` nullable rompería el invariante y las políticas RLS. Tabla nueva global es la opción correcta; mismo patrón que `super_admin_*` de Fase 9A.
5. **Borrar `security_events` con TTL en Postgres (`pg_partman`)** — overkill para un volumen previsible bajo. Cron diario es trivial y reusa `@nestjs/schedule` que ya está en el proyecto.

## Consecuencias

### `security_events` (11A.1)

- **(+)** Auditoría persistente de ataques de credential stuffing entre tenants. Alertas posibles a partir de queries SQL.
- **(+)** El super admin puede investigar incidentes sin pedir logs Loki/Grafana.
- **(+)** Limpieza automática a 90 días evita crecimiento ilimitado.
- **(−)** Una tabla más sin RLS (global). Cuidado con queries directas: sólo accesible desde rutas `/admin` con `AdminGuard`.

### `tenant_aeat_credentials` histórico (11A.2)

- **(+)** Reconstruir qué cert estaba activo en una fecha es un `SELECT * WHERE uploaded_at <= ? AND (revoked_at > ? OR revoked_at IS NULL)`.
- **(+)** Auditorías AEAT futuras pueden consultar el histórico completo.
- **(−)** Más filas con datos cifrados pesados (PKCS#12 base64); manejable con índice `(tenant_id, uploaded_at DESC)`.
- **(~)** El "borrado" GDPR de un tenant tiene que borrar también las filas históricas (ya cubierto por `ON DELETE CASCADE`).

### CSP Report-Only (11A.3)

- **(+)** Defensa en profundidad contra XSS sin riesgo de downtime durante el rollout.
- **(+)** Reports en `/api/csp-report` permiten ajustar la policy antes de enforcement.
- **(−)** `'unsafe-inline'` en `script-src` y `style-src` (necesario para Next.js + Tailwind hasta que migremos a nonces). Mitigación: pasar a nonces en una fase posterior.
- **(−)** Hay que mantener la lista de hosts (Stripe, MinIO, eventual CDN) cuando integremos algo nuevo.

### Rectificativas R1-R5 (11A.4)

- **(+)** Cumple Veri\*Factu completo (no solo F1). Indispensable para clientes con devoluciones/concursos/errores de NIF.
- **(+)** Hash encadenado se mantiene: una rectificativa es un `RegistroAlta` más con `TipoRectificativa`, no rompe la cadena de la serie.
- **(−)** UI tiene que distinguir visualmente entre original y rectificativa (badge + link a la otra). Esto añade complejidad menor en `/invoices/[id]`.
- **(~)** Solo `correctionMethod='I'` (por diferencias) tiene tests e2e. La sustitución (`S`) está en el DTO pero queda no probada hasta que un cliente la pida.

## Implementación (fichero por bloque)

### 11A.1 — `security_events`

- `packages/database/prisma/migrations/20260529000000_phase11a_security_events/`
- `apps/api/src/modules/security/security-events.service.ts`
- `apps/api/src/modules/security/security-events.admin.controller.ts`
- `apps/api/src/modules/security/security-events.cleanup.processor.ts`
- `apps/web/src/app/admin/security-events/page.tsx`

### 11A.2 — `tenant_aeat_credentials` histórico

- `packages/database/prisma/migrations/20260529000100_phase11a_aeat_credentials_history/` (drop UNIQUE, añade índice parcial `WHERE revoked_at IS NULL`).
- `apps/api/src/modules/billing/aeat/tenant-aeat-credentials.service.ts` (upload via `$transaction`, listHistory).
- `apps/api/src/modules/billing/aeat/tenant-aeat-credentials.controller.ts` (`GET /billing/aeat-credentials/history`).
- `apps/web/src/app/(app)/settings/billing/verifactu/page.tsx` (acordeón histórico).

### 11A.3 — CSP Report-Only

- `apps/web/next.config.mjs` (headers).
- `apps/web/src/app/api/csp-report/route.ts`.
- `apps/web/src/middleware.ts` (excepción `/widget/:path*`).
- `docs/ARCHITECTURE.md` (sección CSP).

### 11A.4 — Rectificativas

- `packages/database/prisma/migrations/20260529000200_phase11a_invoice_rectifications/`.
- `apps/api/src/modules/billing/invoices.service.ts` (`rectify`).
- `apps/api/src/modules/billing/invoices.controller.ts` (`POST /invoices/:id/rectify`).
- `apps/api/src/modules/billing/aeat-client/verifactu-xml-builder.ts` (`TipoRectificativa` + `FacturasRectificadas`).
- `apps/api/src/modules/billing/aeat-client/real-aeat.client.ts` (carga original).
- `apps/web/src/app/(app)/invoices/[id]/page.tsx` (botón Rectificar + badge).

### 11A.5 — Este ADR + actualización ROADMAP/CLAUDE/README/vault Obsidian.

## Referencias

- **RD 1007/2023** — reglamento Veri\*Factu: <https://www.boe.es/eli/es/rd/2023/12/05/1007>
- **Orden HAC/1177/2024** — desarrollo del reglamento (incluye campos `TipoRectificativa`, `FacturasRectificadas`): <https://www.boe.es/eli/es/o/2024/10/17/hac1177>
- **Ley 37/1992 IVA art. 80** — supuestos de rectificación (R1-R5).
- **MDN CSP**: <https://developer.mozilla.org/docs/Web/HTTP/CSP>
- **OWASP CSP Cheat Sheet**: <https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html>
- **CSP `Report-Only` vs enforcement**: <https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy-Report-Only>
- ADR-008 (Fase 10): cliente AEAT real.
- ADR-039 (Fase 8): super admin con auth separada.
- ADR-042 (Fase 9A): 2FA + cookie httpOnly del super admin.
