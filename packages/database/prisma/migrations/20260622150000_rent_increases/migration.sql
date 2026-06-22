-- Revenue: subidas de precio a clientes en cartera (ECRI).
--
-- Una "tanda" (rent_increases) aplica un aumento (% o fijo) a los contratos que
-- cumplen el scope, con preaviso por email y aplicación programada en la fecha
-- efectiva (cron). Los items congelan el precio antiguo/nuevo por contrato.

CREATE TABLE "rent_increases" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "scope" JSONB NOT NULL DEFAULT '{}',
  -- percentage | fixed
  "increase_type" TEXT NOT NULL,
  "increase_value" DECIMAL(10, 2) NOT NULL,
  "effective_date" DATE NOT NULL,
  -- scheduled | applied | cancelled
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "affected_count" INTEGER NOT NULL DEFAULT 0,
  "applied_count" INTEGER NOT NULL DEFAULT 0,
  -- delta mensual de MRR (suma de new-old) congelado al crear
  "mrr_delta" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "notice_sent" BOOLEAN NOT NULL DEFAULT false,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "applied_at" TIMESTAMPTZ(6),
  CONSTRAINT "rent_increases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rent_increases_tenant_id_status_idx" ON "rent_increases"("tenant_id", "status");
CREATE INDEX "rent_increases_status_effective_date_idx" ON "rent_increases"("status", "effective_date");

ALTER TABLE "rent_increases"
  ADD CONSTRAINT "rent_increases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "rent_increase_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "rent_increase_id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "old_price" DECIMAL(10, 2) NOT NULL,
  "new_price" DECIMAL(10, 2) NOT NULL,
  -- pending | applied | skipped
  "status" TEXT NOT NULL DEFAULT 'pending',
  "skip_reason" TEXT,
  "applied_at" TIMESTAMPTZ(6),
  CONSTRAINT "rent_increase_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rent_increase_items_increase_contract_key"
  ON "rent_increase_items"("rent_increase_id", "contract_id");
CREATE INDEX "rent_increase_items_tenant_id_idx" ON "rent_increase_items"("tenant_id");

ALTER TABLE "rent_increase_items"
  ADD CONSTRAINT "rent_increase_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rent_increase_items"
  ADD CONSTRAINT "rent_increase_items_rent_increase_id_fkey"
  FOREIGN KEY ("rent_increase_id") REFERENCES "rent_increases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rent_increase_items"
  ADD CONSTRAINT "rent_increase_items_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rent_increases" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "rent_increases";
CREATE POLICY tenant_isolation ON "rent_increases"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "rent_increase_items" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "rent_increase_items";
CREATE POLICY tenant_isolation ON "rent_increase_items"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
