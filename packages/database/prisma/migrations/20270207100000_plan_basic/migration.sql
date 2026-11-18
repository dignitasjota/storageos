-- Plan Basic (1 € por trastero, mínimo 19 €), extras por plan y Pro hasta 1.000 trasteros.

-- Trasteros incluidos en la cuota; los que pasen se cobran con el extra
-- interno «Trasteros de más».
ALTER TABLE "subscription_plans" ADD COLUMN "included_units" INTEGER;

-- Extras que solo se pueden tener en ciertos planes, con cantidad máxima, y
-- extras de la plataforma que no se contratan a mano.
ALTER TABLE "subscription_addons"
  ADD COLUMN "plan_slugs" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "max_quantity" INTEGER,
  ADD COLUMN "is_system" BOOLEAN NOT NULL DEFAULT false;

-- Periodo para el que ya se fijaron los trasteros de más.
ALTER TABLE "tenant_subscriptions" ADD COLUMN "units_billed_for" TIMESTAMPTZ(6);

-- Pro pasa a tener hasta 1.000 trasteros (más, con un plan a medida).
UPDATE "subscription_plans" SET "max_units" = 1000 WHERE "slug" = 'pro' AND "max_units" IS NULL;

-- El plan gratis deja de ofrecerse (sigue para quien lo tiene hasta pasar a Basic).
UPDATE "subscription_plans" SET "is_public" = false WHERE "slug" = 'free';
