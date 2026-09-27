-- Vincula cada comunicación con el contrato y/o la factura que la originó
-- (recordatorio de impago → factura; subida de precio, firma, PIN, valoración →
-- contrato). Permite enlazar desde /communications y filtrar por recurso.
-- SET NULL: borrar el contrato/factura no borra el historial de envíos.
ALTER TABLE "communications" ADD COLUMN "contract_id" UUID;
ALTER TABLE "communications" ADD COLUMN "invoice_id" UUID;

ALTER TABLE "communications"
  ADD CONSTRAINT "communications_contract_id_fkey" FOREIGN KEY ("contract_id")
  REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "communications"
  ADD CONSTRAINT "communications_invoice_id_fkey" FOREIGN KEY ("invoice_id")
  REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "communications_tenant_id_contract_id_idx" ON "communications"("tenant_id", "contract_id");
CREATE INDEX "communications_tenant_id_invoice_id_idx" ON "communications"("tenant_id", "invoice_id");
