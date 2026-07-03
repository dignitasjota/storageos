-- Rastreo de reintentos de cobro de la suscripción SaaS, para el «retry
-- analysis» del super admin. Un pago fallido de Stripe (`invoice.payment_failed`)
-- ahora se persiste con `failed_attempts`/`first_failed_at`; si luego se cobra,
-- se marca `recovered_at`. Permite medir la tasa de recuperación de impagos.
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "failed_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "first_failed_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant_subscription_payments" ADD COLUMN "recovered_at" TIMESTAMPTZ(6);
CREATE INDEX "tenant_subscription_payments_first_failed_at_idx" ON "tenant_subscription_payments" ("first_failed_at");
