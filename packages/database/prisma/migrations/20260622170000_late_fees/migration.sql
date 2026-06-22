-- Revenue / cobro: recargos por mora (late fees).
--
-- Cuando una factura lleva N días vencida (opt-in por tenant), se genera una
-- FACTURA SEPARADA de recargo (no se puede modificar la original ya emitida con
-- hash Verifactu encadenado). El recargo es % del importe vencido o € fijo.

-- Config por tenant (opt-in).
ALTER TABLE "tenants" ADD COLUMN "late_fee_enabled" BOOLEAN NOT NULL DEFAULT false;
-- percentage | fixed
ALTER TABLE "tenants" ADD COLUMN "late_fee_type" TEXT NOT NULL DEFAULT 'percentage';
ALTER TABLE "tenants" ADD COLUMN "late_fee_value" DECIMAL(10, 2) NOT NULL DEFAULT 5;
ALTER TABLE "tenants" ADD COLUMN "late_fee_grace_days" INTEGER NOT NULL DEFAULT 7;

-- Enlace del recargo a la factura original (idempotencia: una sola por factura).
ALTER TABLE "invoices" ADD COLUMN "late_fee_for_invoice_id" UUID;
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_late_fee_for_invoice_id_fkey"
  FOREIGN KEY ("late_fee_for_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "invoices_late_fee_for_invoice_id_key"
  ON "invoices"("late_fee_for_invoice_id")
  WHERE "late_fee_for_invoice_id" IS NOT NULL;
