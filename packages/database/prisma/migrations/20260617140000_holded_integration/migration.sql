-- Plan 4 (Holded): integración contable por tenant.

ALTER TABLE "invoices" ADD COLUMN "holded_document_id" TEXT;

CREATE TABLE "holded_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "api_key_encrypted" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "last_sync_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "holded_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "holded_settings_tenant_id_key" ON "holded_settings"("tenant_id");

ALTER TABLE "holded_settings"
  ADD CONSTRAINT "holded_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "holded_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "holded_settings";
CREATE POLICY tenant_isolation ON "holded_settings"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
