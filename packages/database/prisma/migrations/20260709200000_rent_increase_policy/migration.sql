-- Política de subidas de precio (ECRI): tope de % anual y meses mínimos entre
-- subidas al mismo contrato (para no solapar subidas).
ALTER TABLE "tenants"
    ADD COLUMN "rent_increase_max_annual_pct" DECIMAL(5, 2) NOT NULL DEFAULT 0,
    ADD COLUMN "rent_increase_min_months_between" INTEGER NOT NULL DEFAULT 12;
