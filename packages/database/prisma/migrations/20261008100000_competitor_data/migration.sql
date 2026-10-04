-- Datos de la competencia para afinar el precio: contacto, ubicación, costes,
-- promociones, características, inventario completo y revisiones.
ALTER TABLE "competitor_facilities"
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "website" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "contact_method" TEXT,
  ADD COLUMN "contact_notes" TEXT,
  ADD COLUMN "distance_km" DECIMAL(8,2),
  ADD COLUMN "inventory_complete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inventory_completed_at" TIMESTAMPTZ(6),
  ADD COLUMN "known_total_units" INTEGER,
  ADD COLUMN "current_promotion" TEXT,
  ADD COLUMN "deposit_amount" DECIMAL(10,2),
  ADD COLUMN "setup_fee" DECIMAL(10,2),
  ADD COLUMN "mandatory_insurance_monthly" DECIMAL(10,2),
  ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "last_reviewed_at" TIMESTAMPTZ(6);

-- Referencia del trastero en el competidor (su código, si lo publica).
ALTER TABLE "competitor_units" ADD COLUMN "external_ref" TEXT;

-- Histórico: cada comprobación de un trastero de la competencia.
CREATE TABLE "competitor_unit_observations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "competitor_unit_id" UUID NOT NULL,
  "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "price_monthly" DECIMAL(10,2) NOT NULL,
  "status" TEXT NOT NULL,
  CONSTRAINT "competitor_unit_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "competitor_unit_observations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "competitor_unit_observations_unit_fkey" FOREIGN KEY ("competitor_unit_id") REFERENCES "competitor_units"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "competitor_unit_observations_unit_idx" ON "competitor_unit_observations"("competitor_unit_id", "observed_at");
ALTER TABLE "competitor_unit_observations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "competitor_unit_observations" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Lo que ya había fichado cuenta como primera observación.
INSERT INTO "competitor_unit_observations" ("tenant_id", "competitor_unit_id", "observed_at", "price_monthly", "status")
SELECT "tenant_id", "id", "last_checked_at", "price_monthly", "status" FROM "competitor_units";

-- Historial de precios de mis trasteros (para medir el efecto de cada cambio).
CREATE TABLE "unit_price_history" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "previous_price" DECIMAL(10,2) NOT NULL,
  "new_price" DECIMAL(10,2) NOT NULL,
  "source" TEXT NOT NULL,
  "changed_by_user_id" UUID,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "unit_price_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "unit_price_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "unit_price_history_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "unit_price_history_user_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "unit_price_history_unit_idx" ON "unit_price_history"("unit_id", "changed_at");
ALTER TABLE "unit_price_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "unit_price_history" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
