-- Seguimientos/recordatorios del staff sobre un inquilino (CRM): "llamar el día X",
-- "renovar contrato", etc. Con fecha de vencimiento y estado.
CREATE TABLE "customer_followups" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "user_id" UUID,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "customer_followups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_followups_tenant_id_idx" ON "customer_followups" ("tenant_id");
CREATE INDEX "customer_followups_tenant_status_due_idx" ON "customer_followups" ("tenant_id", "status", "due_date");
CREATE INDEX "customer_followups_customer_id_idx" ON "customer_followups" ("customer_id");

ALTER TABLE "customer_followups"
    ADD CONSTRAINT "customer_followups_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_followups"
    ADD CONSTRAINT "customer_followups_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_followups"
    ADD CONSTRAINT "customer_followups_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "customer_followups" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "customer_followups";
CREATE POLICY tenant_isolation ON "customer_followups" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
