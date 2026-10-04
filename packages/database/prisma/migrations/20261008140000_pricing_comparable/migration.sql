-- Precio comparable: promoción de la competencia como dato y características
-- de mis locales (para comparar lo comparable).
ALTER TABLE "competitor_facilities"
  ADD COLUMN "promo_free_months" INTEGER,
  ADD COLUMN "promo_discount_pct" INTEGER,
  ADD COLUMN "promo_discount_months" INTEGER;

ALTER TABLE "facilities"
  ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
