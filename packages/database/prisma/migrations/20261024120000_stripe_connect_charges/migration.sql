-- Stripe Connect: tarjetas guardadas y cobros en la cuenta de Stripe del tenant.
-- null = cuenta de Stripe de la plataforma (solo con TENANT_CARD_PAYMENTS_ENABLED).
ALTER TABLE "payment_methods" ADD COLUMN "stripe_account_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "stripe_account_id" TEXT;
-- Comisión de la plataforma cobrada en este pago.
ALTER TABLE "payments" ADD COLUMN "application_fee_amount" DECIMAL(12,2);
CREATE INDEX "payments_stripe_account_idx" ON "payments" ("stripe_account_id") WHERE "stripe_account_id" IS NOT NULL;
