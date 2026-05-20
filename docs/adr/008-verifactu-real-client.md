# 008. Cliente AEAT real para Veri\*Factu

- Fecha: 2026-05-20
- Estado: aceptada
- Fase: 10 (Veri\*Factu real)
- Reemplaza/amplía: Fase 9A.5 (`AeatClient` abstracto + Stub + Real skeleton)

## Contexto

Para vender StorageOS como SaaS de facturación a empresas españolas a partir del **2026-07-01** (entrada en vigor del **RD 1007/2023** Veri\*Factu) hace falta envío real e inmediato de cada factura al AEAT.

En Fase 4 ya dejamos preparada toda la estructura de "registro de facturación" (hash SHA-256 encadenado entre facturas de la misma serie, QR AEAT como data URL, campos `aeat_status`/`aeat_sent_at`/`aeat_response`/`csv` en `invoices`). En Fase 9A.5 abstraímos el envío (`AeatClient` interface + `StubAeatClient` + `RealAeatClient` skeleton) para que el cambio a real fuera por env var. Fase 10 completa el `RealAeatClient`.

Cuestiones a resolver:

1. ¿Veri\*Factu o SII?
2. ¿Quién es el emisor fiscal: cada tenant o StorageOS como presentador?
3. ¿Es necesaria firma XAdES?
4. ¿Qué librerías HTTP/SOAP/crypto usar?
5. ¿Cómo gestionar errores AEAT y reintentos?

## Decisión

### 1. Veri\*Factu (modo verificable), NO SII

Implementamos **Veri\*Factu** (sistema de emisión de facturas verificables). El **SII** (Suministro Inmediato de Información) solo aplica a empresas con facturación > 6M€ anuales y a inscritas en el régimen de devolución mensual — atípico en el sector self-storage objetivo de StorageOS.

Veri\*Factu cubre el caso de uso de PYMEs/autónomos y satisface igualmente el RD 1007/2023: emisión + envío inmediato + encadenamiento criptográfico.

### 2. Certificado por tenant (no "presentador autorizado")

Cada tenant sube su **propio certificado digital PKCS#12** (FNMT-CERES, Camerfirma, ANCERT, EDICOM o cualquier PSC reconocido). El tenant es el **emisor fiscal real**; StorageOS solo opera el software.

- El certificado se almacena en `tenant_aeat_credentials` cifrado AES-256-GCM con `MASTER_ENCRYPTION_KEY` (mismo mecanismo que tokens Stripe, ADR-007/ADR-015). La password del certificado se cifra con el mismo mecanismo en columna independiente.
- La metadata (CN, NIF, issuer, `notBefore`, `notAfter`) se extrae al subir y se persiste en claro para mostrarla en `/settings/billing/verifactu` sin descifrar en cada render.
- El NIF del certificado debe coincidir con `tenants.tax_id` (validación implícita: si no coincide AEAT rechaza el registro).

### 3. Sin firma XAdES

El **modo verificable de Veri\*Factu NO requiere XAdES-BES**. La integridad se basa en:

- Hash SHA-256 encadenado entre registros de la misma serie (`previous_hash` → `hash` → siguiente).
- Envío en tiempo real al AEAT por canal autenticado mTLS.
- "Huella" calculada por el sistema informático declarada en el propio XML.

XAdES sería necesario solo en el "sistema NO verificable" (offline batch + firma a posteriori), que no implementamos.

### 4. mTLS con `https.Agent` nativo Node + parser SOAP regex tolerante

- `RealAeatClient` usa el `https` nativo de Node + `https.Agent` con `cert`/`key`/`passphrase` extraídos del PKCS#12 con `node-forge`. No usamos `axios` (overhead innecesario, gestiona mal mTLS por instancia) ni `node-soap` (genera un cliente entero a partir de WSDL; demasiado pesado para una sola operación).
- El XML de request lo construye `VerifactuXmlBuilder` a mano según el XSD oficial AEAT (`RegistroAlta` con encadenamiento + sistema informático + huella). Helpers `formatSpanishDate`, `escapeXml`.
- La respuesta SOAP se parsea con regex tolerante a namespaces (`<.*?:?EstadoRegistro>...`). La AEAT usa varios prefijos según endpoint; un parser estricto rompe en sandbox vs producción.

### 5. Cola BullMQ con retry 3× exponencial

- Cola dedicada `verifactu`, job `send-to-aeat`, concurrency 2.
- Retry 3× con backoff exponencial base 60s (≈ 1m, 5m, 25m).
- **Errores técnicos reintentan**: timeout, 5xx, errores TLS, errores de red.
- **Rechazos AEAT no reintentan**: si AEAT devuelve `EstadoRegistro=Rechazada`, es una decisión firme (validación del registro). Requiere revisión manual del operador o del tenant (datos del cliente erróneos, NIF inválido, etc.).
- Endpoint manual `POST /billing/invoices/:id/resend-aeat` permite reenviar facturas en `error` o `rejected` tras corregir datos.

## Alternativas consideradas y rechazadas

1. **SII en lugar de Veri\*Factu** — solo aplica a empresas grandes; raro en self-storage. Además SII requiere más campos (regímenes especiales, contraprestación, etc.) y tiene endpoints distintos.
2. **StorageOS como "presentador autorizado"** — un único certificado de StorageOS firma todos los envíos en nombre de los tenants. Requiere autorización notarial por cada tenant (modelo "apoderado") y abriría responsabilidad fiscal sobre nosotros. Demasiada fricción operacional y legal. Descartado.
3. **Implementar XAdES-BES con `xadesjs` o `xml-crypto`** — el modo Veri\*Factu no lo requiere. Solo sería necesario en el "sistema no verificable", que no implementamos.
4. **Usar una librería SOAP completa (`node-soap`)** — añadiría un cliente generado desde WSDL para una sola operación (`RegFactuSistemaFacturacion`). El XML manual es ~150 líneas y nos da control sobre namespaces y formato; con `node-soap` perderíamos esa control y heredaríamos sus bugs históricos con mTLS.
5. **Usar `axios` para el POST** — soporta mTLS pero requiere instanciar un `https.Agent` igualmente, y `axios` añade overhead de parsing JSON automático que aquí no queremos (la respuesta es XML). El `https.request` nativo es 30 líneas y suficiente.

## Trade-offs

- **Operacional**: cada tenant debe gestionar su propio certificado (renovación cada 2-4 años según PSC). El onboarding incluye una pantalla específica (`/settings/billing/verifactu`) y un email de aviso al expirar. No es invisible para el cliente, pero es el modelo correcto: el emisor fiscal es el tenant.
- **Legal**: el emisor real es el tenant; StorageOS aparece declarado como "Sistema Informático" en cada registro (campos `AEAT_SISTEMA_*`). Esto encaja con la responsabilidad fiscal de cada empresa.
- **Falta `getStatus` async**: actualmente no hay un endpoint de consulta de estado post-envío. La respuesta SOAP es síncrona (`accepted` o `rejected` en el mismo POST). Si en el futuro AEAT añade un flow asíncrono (CSV consultable a posteriori), habrá que implementar polling. Por ahora no hace falta.
- **Multi-instalación**: `AEAT_SISTEMA_INSTALACION=001` es fijo en `.env`. Si un día desplegamos varias instalaciones del SaaS bajo el mismo NIF de desarrollador (StorageOS), cada una necesita un identificador distinto.

## Implementación (fichero por bloque)

### 10A.1 — Persistencia del certificado por tenant

- `packages/database/prisma/schema.prisma`: tabla `TenantAeatCredentials` (1 por tenant, RLS).
- `apps/api/src/modules/billing/aeat/tenant-aeat-credentials.service.ts`: `upload`, `getDecrypted`, `getMetadata`, `revoke`.
- `apps/api/src/modules/billing/aeat/tenant-aeat-credentials.controller.ts`: `POST /billing/aeat-credentials/me` (multipart), `GET`, `DELETE`.

### 10A.2 — XML builder

- `apps/api/src/modules/billing/aeat/verifactu-xml-builder.ts`: `buildRegistroAlta(invoice, prevHash, sistema)` devuelve string con SOAP envelope conforme al XSD AEAT.

### 10A.3 — Cliente AEAT real

- `apps/api/src/modules/billing/aeat/real-aeat-client.ts`: `sendInvoice(xml, cert, password)` → POST mTLS + parseo regex de la respuesta SOAP.

### 10A.4 — Procesador BullMQ + endpoint resend

- `apps/api/src/modules/billing/aeat/verifactu.processor.ts`: worker BullMQ.
- `apps/api/src/modules/billing/aeat/verifactu-aeat.controller.ts`: `POST /billing/invoices/:id/resend-aeat`.

### 10A.5 — UI tenant

- `apps/web/src/app/(app)/settings/billing/verifactu/page.tsx`: subir/ver/revocar certificado.
- `apps/web/src/components/invoices/VerifactuBadge.tsx`: badge en `/invoices/[id]` con estado + botón Reenviar + modal raw response.

### 10A.6 — Documentación

- `docs/DEPLOYMENT.md` sección 11.
- `docs/ARCHITECTURE.md` sección Veri\*Factu + ADR-020.

### 10A.7 — Este ADR + actualización ROADMAP/CLAUDE.md + vault Obsidian.

## Referencias

- **RD 1007/2023** sobre el reglamento que establece los requisitos que deben adoptar los sistemas informáticos de facturación: <https://www.boe.es/eli/es/rd/2023/12/05/1007>
- **Orden HAC/1177/2024** que desarrolla el reglamento: <https://www.boe.es/eli/es/o/2024/10/17/hac1177>
- **Sede AEAT — Sistemas de facturación informáticos**: <https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu.html>
- **XSD oficial Veri\*Factu (RegFactuSistemaFacturacion)**: publicado por AEAT en la sede; descarga obligatoria por OAuth en el portal de desarrolladores.
- **Endpoints AEAT**:
  - Sandbox/preproducción: `https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1`
  - Producción: `https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/SistemaFacturacionV1`
- **FNMT-CERES** (cert gratuito persona física/jurídica): <https://www.sede.fnmt.gob.es/certificados>
