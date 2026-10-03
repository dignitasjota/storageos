-- Las facturas de suscripción se emiten como facturas del tenant propio de la
-- sociedad emisora (el «negocio propio»), con cada tenant como su cliente: así
-- comparten la cadena Veri*Factu, el modo de emisión y la exportación.

-- Factura real (del tenant propio) que respalda cada factura de suscripción.
ALTER TABLE "platform_invoices" ADD COLUMN "invoice_id" UUID;
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "platform_invoices_invoice_id_key" ON "platform_invoices"("invoice_id");
-- La numeración propia (SAAS-AAAA-NNNN) solo aplica a las facturas de su
-- serie: las emitidas por el tenant propio (serie 'own') llevan el número de
-- esa factura.
DROP INDEX "platform_invoices_series_number_key";
CREATE UNIQUE INDEX "platform_invoices_series_number_key" ON "platform_invoices"("series", "number")
  WHERE "series" <> 'own';

-- En la factura real: el pago de suscripción que factura (idempotencia).
ALTER TABLE "invoices" ADD COLUMN "platform_payment_id" UUID;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_platform_payment_id_fkey"
  FOREIGN KEY ("platform_payment_id") REFERENCES "tenant_subscription_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "invoices_platform_payment_id_key" ON "invoices"("platform_payment_id");

-- Cliente del tenant propio que representa a un tenant de la plataforma.
ALTER TABLE "customers" ADD COLUMN "platform_tenant_id" UUID;
ALTER TABLE "customers" ADD CONSTRAINT "customers_platform_tenant_id_fkey"
  FOREIGN KEY ("platform_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "customers_tenant_platform_tenant_key" ON "customers"("tenant_id", "platform_tenant_id")
  WHERE "platform_tenant_id" IS NOT NULL;

-- Reserva del pago mientras se factura (dos procesos no lo facturan dos veces).
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "invoicing_claimed_at" TIMESTAMPTZ(6);
