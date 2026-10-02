-- Veri*Factu conforme (auditoría de facturación, PR 5). Aún no está en
-- producción: las huellas anteriores (algoritmo simplificado) nunca se
-- registraron en la AEAT, así que la cadena oficial empieza de cero.
--
-- La cadena de huellas es POR EMISOR (el tenant), no por serie: todas las
-- facturas emitidas del tenant, en el orden en que se generan.
--   chain_seq: posición en la cadena del tenant (única por tenant).
--   previous_invoice_id: registro anterior (para <RegistroAnterior>).
--   aeat_record_timestamp: FechaHoraHusoGenRegistro tal cual se usó en la
--     huella (se fija al emitir; antes se generaba en cada envío y no
--     coincidía con la huella).
ALTER TABLE "invoices"
  ADD COLUMN "chain_seq" INTEGER,
  ADD COLUMN "previous_invoice_id" UUID,
  ADD COLUMN "aeat_record_timestamp" TEXT;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_previous_invoice_id_fkey"
  FOREIGN KEY ("previous_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX "invoices_tenant_chain_seq"
  ON "invoices" ("tenant_id", "chain_seq")
  WHERE "chain_seq" IS NOT NULL;
