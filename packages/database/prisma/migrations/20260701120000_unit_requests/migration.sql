-- Solicitud de un trastero adicional desde el portal del inquilino: ve la
-- disponibilidad de su local y manda una solicitud que el staff gestiona.
CREATE TABLE "unit_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "facility_id" UUID,
    "unit_type_id" UUID,
    "unit_id" UUID,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution_note" TEXT,
    "handled_by_user_id" UUID,
    "handled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "unit_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "unit_requests_tenant_status_idx" ON "unit_requests" ("tenant_id", "status");
CREATE INDEX "unit_requests_tenant_customer_idx" ON "unit_requests" ("tenant_id", "customer_id");

ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_unit_type_id_fkey"
    FOREIGN KEY ("unit_type_id") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_unit_id_fkey"
    FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "unit_requests" ADD CONSTRAINT "unit_requests_handled_by_user_id_fkey"
    FOREIGN KEY ("handled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "unit_requests" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "unit_requests";
CREATE POLICY tenant_isolation ON "unit_requests" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
