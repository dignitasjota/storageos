-- Features premium (gateadas por plan) editables desde la BD, en vez del mapa
-- `PLAN_FEATURES` en código. Columna separada del `features` jsonb (que guarda
-- metadata de marketing: support/branding/api).
ALTER TABLE "subscription_plans" ADD COLUMN "tenant_features" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill con los valores actuales del mapa en código (planes ya existentes).
UPDATE "subscription_plans" SET "tenant_features" =
  ARRAY['rent_increases','insurance','access_control','automations']::TEXT[]
  WHERE slug = 'starter';
UPDATE "subscription_plans" SET "tenant_features" =
  ARRAY['ai_assistant','sepa','bank_reconciliation','rent_increases','insurance','access_control','automations']::TEXT[]
  WHERE slug = 'pro';
-- 'free' se queda con '{}'.
