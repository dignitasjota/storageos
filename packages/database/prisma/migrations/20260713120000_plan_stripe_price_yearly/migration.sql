-- Facturación anual del SaaS: cada plan puede tener un Stripe Price anual además
-- del mensual. El checkout/cambio de plan usa uno u otro según billingCycle.
ALTER TABLE "subscription_plans" ADD COLUMN "stripe_price_id_yearly" TEXT;
