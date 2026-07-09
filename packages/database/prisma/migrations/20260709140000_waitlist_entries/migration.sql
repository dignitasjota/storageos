-- Lista de espera: un cliente (o contacto libre) se apunta a un tipo de trastero
-- en un local sin disponibilidad; al liberarse una unidad de ese tipo se avisa
-- al primero de la cola (orden de llegada).
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "unit_type_id" UUID NOT NULL,
    "customer_id" UUID,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "notified_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- Cola por (local, tipo): las entradas `waiting` ordenadas por antigüedad.
CREATE INDEX "waitlist_entries_queue_idx"
    ON "waitlist_entries" ("tenant_id", "facility_id", "unit_type_id", "status", "created_at");
CREATE INDEX "waitlist_entries_tenant_status_idx" ON "waitlist_entries" ("tenant_id", "status");

ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_unit_type_id_fkey"
    FOREIGN KEY ("unit_type_id") REFERENCES "unit_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "waitlist_entries";
CREATE POLICY tenant_isolation ON "waitlist_entries" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
