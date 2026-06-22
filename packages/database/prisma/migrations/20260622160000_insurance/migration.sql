-- Revenue: seguro / protección de contenido como add-on recurrente.
--
-- Un `insurance_plans` (catálogo del tenant) se asigna a un contrato; la prima
-- se factura como una línea más en la factura mensual del alquiler. La prima
-- se congela en el contrato al asignarla (`insurance_price`) para que cambiar
-- la tarifa del plan no afecte a contratos ya vinculados.

CREATE TABLE "insurance_plans" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "monthly_price" DECIMAL(10, 2) NOT NULL,
  "coverage_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "tax_rate" DECIMAL(5, 2) NOT NULL DEFAULT 21,
  "description" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "insurance_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "insurance_plans_tenant_id_idx" ON "insurance_plans"("tenant_id");

ALTER TABLE "insurance_plans"
  ADD CONSTRAINT "insurance_plans_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "insurance_plans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "insurance_plans";
CREATE POLICY tenant_isolation ON "insurance_plans"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Vínculo seguro ↔ contrato (snapshot de la prima al asignar).
ALTER TABLE "contracts" ADD COLUMN "insurance_plan_id" UUID;
ALTER TABLE "contracts" ADD COLUMN "insurance_price" DECIMAL(10, 2);

ALTER TABLE "contracts"
  ADD CONSTRAINT "contracts_insurance_plan_id_fkey"
  FOREIGN KEY ("insurance_plan_id") REFERENCES "insurance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
