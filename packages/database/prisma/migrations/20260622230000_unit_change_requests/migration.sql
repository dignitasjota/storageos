-- Portal: el inquilino solicita un cambio/upgrade de trastero. El staff la gestiona.

CREATE TABLE "unit_change_requests" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "contract_id" UUID,
  "note" TEXT NOT NULL,
  -- pending | handled | rejected
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resolution_note" TEXT,
  "handled_by_user_id" UUID,
  "handled_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "unit_change_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "unit_change_requests_tenant_id_status_idx" ON "unit_change_requests"("tenant_id", "status");
CREATE INDEX "unit_change_requests_tenant_id_customer_id_idx" ON "unit_change_requests"("tenant_id", "customer_id");
ALTER TABLE "unit_change_requests"
  ADD CONSTRAINT "unit_change_requests_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_change_requests"
  ADD CONSTRAINT "unit_change_requests_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_change_requests"
  ADD CONSTRAINT "unit_change_requests_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "unit_change_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "unit_change_requests";
CREATE POLICY tenant_isolation ON "unit_change_requests" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
