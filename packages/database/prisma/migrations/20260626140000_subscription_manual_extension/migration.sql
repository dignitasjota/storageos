-- Acumulador de días de crédito por pagos manuales de la suscripción. El periodo
-- efectivo = fecha de Stripe + estos días, de modo que un pago manual se SUMA al
-- cobro recurrente de Stripe en vez de pisarse (crédito permanente).
ALTER TABLE "tenant_subscriptions" ADD COLUMN "manual_extension_days" INTEGER NOT NULL DEFAULT 0;
