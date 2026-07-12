-- Gastos recurrentes (plantilla): el operador define un gasto fijo mensual
-- (alquiler, suministros, personal…) y un cron genera el `expense` cada mes.
CREATE TABLE "recurring_expenses" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID,
    "category" TEXT NOT NULL DEFAULT 'other',
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12, 2) NOT NULL,
    "day_of_month" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    -- Primer día del mes del último gasto generado (dedup: 1 por mes).
    "last_generated_month" DATE,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recurring_expenses_tenant_idx" ON "recurring_expenses" ("tenant_id", "active");

ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recurring_expenses" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "recurring_expenses";
CREATE POLICY tenant_isolation ON "recurring_expenses" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
