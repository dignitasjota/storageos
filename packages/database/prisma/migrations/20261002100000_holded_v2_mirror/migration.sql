-- Integración con Holded (API v2) como copia contable: las facturas se crean en
-- series de Holded excluidas de Veri*Factu (la app ya las registra en la AEAT).
ALTER TABLE "holded_settings" ADD COLUMN "invoice_series_id" TEXT;
ALTER TABLE "holded_settings" ADD COLUMN "credit_note_series_id" TEXT;

-- Cobros ya copiados a Holded (no se envían dos veces).
ALTER TABLE "payments" ADD COLUMN "holded_synced_at" TIMESTAMPTZ(6);

-- Factura anulada ya cancelada también en Holded.
ALTER TABLE "invoices" ADD COLUMN "holded_cancelled_at" TIMESTAMPTZ(6);
