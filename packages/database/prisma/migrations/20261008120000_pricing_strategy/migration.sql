-- Estrategia de precios: ocupación objetivo, cambio máximo por vez y espera
-- mínima entre cambios (tenant), posicionamiento frente al mercado (local) y
-- precio mínimo/máximo (tipo de trastero).
ALTER TABLE "tenants"
  ADD COLUMN "pricing_target_occupancy" INTEGER NOT NULL DEFAULT 88,
  ADD COLUMN "pricing_max_step_pct" INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN "pricing_min_days_between_changes" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "facilities"
  ADD COLUMN "pricing_positioning_pct" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "unit_types"
  ADD COLUMN "min_price_monthly" DECIMAL(10,2),
  ADD COLUMN "max_price_monthly" DECIMAL(10,2);
