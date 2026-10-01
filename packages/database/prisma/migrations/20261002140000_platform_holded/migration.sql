-- Copia contable en Holded de las facturas de suscripción (TrasterOS → tenants).
-- Desactivada hasta que se contrate Holded. La serie de Holded debe estar marcada
-- «No enviar a Verifactu».
ALTER TABLE "platform_billing_settings" ADD COLUMN "holded_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "platform_billing_settings" ADD COLUMN "holded_api_key_encrypted" TEXT;
ALTER TABLE "platform_billing_settings" ADD COLUMN "holded_invoice_series_id" TEXT;
ALTER TABLE "platform_billing_settings" ADD COLUMN "holded_last_sync_at" TIMESTAMPTZ(6);
ALTER TABLE "platform_billing_settings" ADD COLUMN "holded_last_error" TEXT;

ALTER TABLE "platform_invoices" ADD COLUMN "holded_document_id" TEXT;
