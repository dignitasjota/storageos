-- Rectificativas de las facturas de suscripción (serie propia «R»).
ALTER TABLE "platform_invoices" ADD COLUMN "invoice_type" TEXT NOT NULL DEFAULT 'F1';
ALTER TABLE "platform_invoices" ADD COLUMN "rectifies_invoice_id" UUID;
ALTER TABLE "platform_invoices" ADD COLUMN "rectification_reason" TEXT;
-- 'substitution' (sustituye a la original) | 'differences' (abono por la diferencia).
ALTER TABLE "platform_invoices" ADD COLUMN "correction_method" TEXT;
ALTER TABLE "platform_invoices"
  ADD CONSTRAINT "platform_invoices_rectifies_invoice_id_fkey"
  FOREIGN KEY ("rectifies_invoice_id") REFERENCES "platform_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "platform_invoices_rectifies_invoice_id_idx" ON "platform_invoices"("rectifies_invoice_id");
