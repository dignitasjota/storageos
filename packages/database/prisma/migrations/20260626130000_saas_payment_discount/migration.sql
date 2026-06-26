-- Pagos manuales de la suscripción SaaS: descuento opcional aplicado (informativo,
-- el precio de lista menos el descuento explica el importe cobrado). El `provider`
-- ya es texto libre (acepta paypal/cash/bank_transfer/other además de stripe).
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "discount" DECIMAL(12, 2);
