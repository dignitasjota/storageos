-- Competencia: el operador ficha manualmente los locales de la competencia y sus
-- trasteros (m² + precio + disponible/ocupado) para anclar la sugerencia de precio.
CREATE TABLE "competitor_facilities" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "zone" TEXT,
    "facility_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "competitor_facilities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_facilities_tenant_idx" ON "competitor_facilities" ("tenant_id");
ALTER TABLE "competitor_facilities" ADD CONSTRAINT "competitor_facilities_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_facilities" ADD CONSTRAINT "competitor_facilities_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "competitor_units" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "competitor_facility_id" UUID NOT NULL,
    "area_m2" DECIMAL(10,2) NOT NULL,
    "price_monthly" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "last_checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "competitor_units_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "competitor_units_facility_idx" ON "competitor_units" ("competitor_facility_id");
CREATE INDEX "competitor_units_tenant_status_idx" ON "competitor_units" ("tenant_id", "status");
ALTER TABLE "competitor_units" ADD CONSTRAINT "competitor_units_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "competitor_units" ADD CONSTRAINT "competitor_units_competitor_facility_id_fkey"
    FOREIGN KEY ("competitor_facility_id") REFERENCES "competitor_facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "competitor_facilities" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "competitor_facilities";
CREATE POLICY tenant_isolation ON "competitor_facilities" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "competitor_units" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "competitor_units";
CREATE POLICY tenant_isolation ON "competitor_units" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
