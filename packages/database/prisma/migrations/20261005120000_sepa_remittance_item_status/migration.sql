-- Remesas SEPA seguras (auditoría de facturación, PR 3).
--
-- Cada adeudo de una remesa tiene su estado:
--   pending   = en una remesa generada, aún sin confirmar (la factura no admite
--               otros cobros: se cobraría dos veces);
--   collected = cobrado al confirmar la remesa;
--   failed    = no se cobró (rechazado por el banco al confirmar, o la factura
--               ya estaba pagada por otra vía) → `failure_reason`;
--   returned  = cobrado y luego devuelto por el banco (R-transaction);
--   cancelled = la remesa se canceló antes de enviarla.
-- Antes una factura solo podía estar en UNA remesa en toda su vida (único por
-- factura): tras una devolución no se podía volver a presentar. Ahora el único
-- es parcial: una sola remesa viva (pending/collected) por factura.
ALTER TABLE "sepa_remittance_items"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "failure_reason" TEXT;

-- Los adeudos existentes toman el estado de su remesa.
UPDATE "sepa_remittance_items" i
SET "status" = CASE r."status"
  WHEN 'confirmed' THEN 'collected'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE 'pending' END
FROM "sepa_remittances" r
WHERE r."id" = i."remittance_id";

ALTER TABLE "sepa_remittance_items" DROP CONSTRAINT "sepa_remittance_items_invoice_id_key";
CREATE UNIQUE INDEX "sepa_remittance_items_live_invoice"
  ON "sepa_remittance_items" ("invoice_id")
  WHERE "status" IN ('pending', 'collected');
CREATE INDEX "sepa_remittance_items_invoice_id_idx" ON "sepa_remittance_items" ("invoice_id");
