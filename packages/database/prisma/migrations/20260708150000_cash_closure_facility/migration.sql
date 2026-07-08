-- Cierre de caja POR LOCAL: `facility_id` opcional. NULL = caja global del tenant
-- (comportamiento previo); con valor = arqueo de un local concreto. Se sustituye
-- el único (tenant, fecha) por dos índices parciales para permitir un cierre
-- global + un cierre por cada local en el mismo día.
ALTER TABLE "cash_closures" ADD COLUMN "facility_id" UUID;

ALTER TABLE "cash_closures"
    ADD CONSTRAINT "cash_closures_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "cash_closures_tenant_date_key";

-- Un único cierre GLOBAL por día (facility_id NULL).
CREATE UNIQUE INDEX "cash_closures_tenant_global_date_key"
    ON "cash_closures" ("tenant_id", "closure_date")
    WHERE "facility_id" IS NULL;

-- Un único cierre por LOCAL y día.
CREATE UNIQUE INDEX "cash_closures_tenant_facility_date_key"
    ON "cash_closures" ("tenant_id", "facility_id", "closure_date")
    WHERE "facility_id" IS NOT NULL;
