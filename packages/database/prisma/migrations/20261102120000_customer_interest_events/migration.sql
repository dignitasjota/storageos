-- Señales del área de clientes: el inquilino mira el seguro, otro trastero o
-- un tamaño mayor y no contrata. Alimentan las oportunidades del panel.
CREATE TABLE "customer_interest_events" (
    "id"           UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id"    UUID NOT NULL,
    "customer_id"  UUID NOT NULL,
    -- insurance | additional_unit | larger_unit | night_pass
    "kind"         TEXT NOT NULL,
    "unit_type_id" UUID,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_interest_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_interest_events_tenant_customer_idx"
    ON "customer_interest_events" ("tenant_id", "customer_id", "created_at" DESC);

ALTER TABLE "customer_interest_events" ADD CONSTRAINT "customer_interest_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_interest_events" ADD CONSTRAINT "customer_interest_events_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_interest_events" ADD CONSTRAINT "customer_interest_events_unit_type_id_fkey"
    FOREIGN KEY ("unit_type_id") REFERENCES "unit_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_interest_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_interest_events";
CREATE POLICY tenant_isolation ON "customer_interest_events" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
