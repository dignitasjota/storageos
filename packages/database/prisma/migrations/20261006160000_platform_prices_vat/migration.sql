-- Precios de planes y extras con IVA incluido (como hasta ahora) o +IVA (se
-- cobra el precio más el IVA). Con +IVA, Stripe aplica un tipo impositivo
-- (TaxRate) que la app crea la primera vez.
ALTER TABLE "platform_billing_settings" ADD COLUMN "prices_include_vat" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "platform_billing_settings" ADD COLUMN "stripe_tax_rate_id" TEXT;
ALTER TABLE "platform_billing_settings" ADD COLUMN "stripe_tax_rate_percent" DECIMAL(5,2);
