-- Veri*Factu por negocio (2026-11-08).
--
-- Hasta ahora toda factura emitida en la app se encadenaba, llevaba el QR de
-- la AEAT y se «enviaba». Con AEAT_MODE=stub (la plataforma aún no conectada
-- con la AEAT) ese envío era simulado, pero el panel decía «Aceptada» con un
-- CSV inventado (STUB-…) y el PDF llevaba el QR y la frase de VERI*FACTU.
--
-- Ahora cada negocio lo activa cuando le toque. Apagado, sus facturas salen
-- sin huella, sin QR y sin envío. Activado, no se apaga hasta el 31 de
-- diciembre de ese año (art. 17 de la Orden HAC/1177/2024).
ALTER TABLE "tenants"
  ADD COLUMN "verifactu_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verifactu_enabled_at" TIMESTAMPTZ(6);

-- Los negocios con facturas ya registradas en la AEAT (pruebas o producción)
-- siguen enviando.
UPDATE "tenants" t
SET "verifactu_enabled" = true,
    "verifactu_enabled_at" = COALESCE(r."first_sent", now())
FROM (
  SELECT "tenant_id", MIN("aeat_sent_at") AS "first_sent"
  FROM "invoices"
  WHERE "aeat_status" IN ('accepted', 'accepted_with_warnings')
    AND COALESCE("aeat_response" ->> 'mode', '') IN ('sandbox', 'production')
  GROUP BY "tenant_id"
) r
WHERE r."tenant_id" = t."id";

-- Las facturas de los demás nunca llegaron a la AEAT: se les quita el registro
-- simulado (estado, CSV, huella, cadena y QR). Su PDF se vuelve a generar, ya
-- sin el QR, la próxima vez que se pida.
UPDATE "invoices" i
SET "hash" = NULL,
    "previous_hash" = NULL,
    "previous_invoice_id" = NULL,
    "chain_seq" = NULL,
    "aeat_record_timestamp" = NULL,
    "qr_code_url" = NULL,
    "aeat_status" = NULL,
    "aeat_sent_at" = NULL,
    "aeat_csv" = NULL,
    "aeat_response" = NULL,
    "pdf_url" = NULL
FROM "tenants" t
WHERE t."id" = i."tenant_id"
  AND t."verifactu_enabled" = false
  AND (i."hash" IS NOT NULL OR i."aeat_status" IS NOT NULL OR i."qr_code_url" IS NOT NULL);
