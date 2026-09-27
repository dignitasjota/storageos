-- Local al que se imputa una factura que NO cuelga de un contrato ni de una
-- venta de producto (p. ej. el pase nocturno, que el inquilino compra para un
-- local concreto). Sirve para el cierre de caja por local.
ALTER TABLE "invoices" ADD COLUMN "facility_id" UUID;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "invoices_tenant_id_facility_id_idx" ON "invoices"("tenant_id", "facility_id");
