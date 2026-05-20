-- Phase 8B: SaaS billing (Stripe Checkout / Billing Portal para suscripciones del tenant).
--
-- Anade los campos necesarios para vincular a Stripe Customer + Subscription:
--   - subscription_plans.stripe_price_id: id del Price recurring de Stripe.
--   - tenant_subscriptions.stripe_customer_id: id del Customer Stripe del tenant.
--   - tenant_subscriptions.stripe_subscription_id: ya existia, ahora con UNIQUE
--     para impedir que un mismo Subscription quede mapeado a dos tenants
--     (importante para idempotencia del webhook customer.subscription.updated).
--
-- Nota: prisma migrate diff genera ruido sobre `units.area_m2/volume_m3`
-- GENERATED y sobre `reservations.time_range` (es una computed expression
-- + EXCLUDE constraint que Prisma no entiende). Se omiten manualmente como
-- hemos hecho en migraciones previas (ver phase2_generated_cols y
-- phase3_reservations_exclude).

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "stripe_price_id" TEXT;

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "stripe_customer_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_stripe_subscription_id_key" ON "tenant_subscriptions"("stripe_subscription_id");
