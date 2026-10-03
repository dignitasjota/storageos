-- Reembolsos, contracargos y devoluciones de los cobros de suscripción: el
-- pago guarda lo devuelto y la factura recibe su rectificativa de abono.
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "refunded_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "refunded_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "disputed_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "dispute_reason" TEXT;

-- Pago de suscripción que registró cada adeudo de la remesa SEPA de la plataforma.
ALTER TABLE "platform_sepa_remittance_items" ADD COLUMN "payment_id" UUID;
ALTER TABLE "platform_sepa_remittance_items" ADD CONSTRAINT "platform_sepa_remittance_items_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "tenant_subscription_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
