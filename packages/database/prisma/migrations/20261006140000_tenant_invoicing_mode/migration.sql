-- Dónde se emiten las facturas del tenant: en la app (Veri*Factu con su
-- certificado) o en Holded (Holded numera y registra). El cambio no se aplica
-- en mitad del año: queda programado para el 1 de enero (pending + from).
ALTER TABLE "tenants" ADD COLUMN "invoicing_mode" TEXT NOT NULL DEFAULT 'app';
ALTER TABLE "tenants" ADD COLUMN "invoicing_mode_pending" TEXT;
ALTER TABLE "tenants" ADD COLUMN "invoicing_mode_pending_from" DATE;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_invoicing_mode_check"
  CHECK ("invoicing_mode" IN ('app', 'holded'));
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_invoicing_mode_pending_check"
  CHECK ("invoicing_mode_pending" IS NULL OR "invoicing_mode_pending" IN ('app', 'holded'));

-- Series de Holded donde se EMITEN (sí van a Veri*Factu), distintas de las de
-- la copia contable (marcadas «No enviar a Verifactu»).
ALTER TABLE "holded_settings" ADD COLUMN "issuing_invoice_series_id" TEXT;
ALTER TABLE "holded_settings" ADD COLUMN "issuing_credit_note_series_id" TEXT;

-- Sistema que emitió cada factura (la app o Holded).
ALTER TABLE "invoices" ADD COLUMN "issued_by" TEXT NOT NULL DEFAULT 'app';
