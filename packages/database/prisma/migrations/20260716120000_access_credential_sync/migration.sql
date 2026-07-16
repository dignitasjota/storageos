-- Patrón B (sync offline): rastro de qué credencial está sincronizada en qué
-- terminal (con el ref del hardware) + cursor de reconciliación por terminal.
ALTER TABLE "access_devices" ADD COLUMN "last_reconciled_at" TIMESTAMPTZ(6);

CREATE TABLE "access_credential_sync" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    -- Ref del hardware (CardNo/recno) devuelto por el terminal.
    "hardware_ref" TEXT NOT NULL,
    -- Estado sincronizado: 'active' | 'suspended' | 'revoked'.
    "state" TEXT NOT NULL DEFAULT 'active',
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "access_credential_sync_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "access_credential_sync_cred_device_key"
    ON "access_credential_sync" ("credential_id", "device_id");
CREATE INDEX "access_credential_sync_tenant_idx" ON "access_credential_sync" ("tenant_id");

ALTER TABLE "access_credential_sync" ADD CONSTRAINT "access_credential_sync_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_credential_sync" ADD CONSTRAINT "access_credential_sync_credential_id_fkey"
    FOREIGN KEY ("credential_id") REFERENCES "access_credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_credential_sync" ADD CONSTRAINT "access_credential_sync_device_id_fkey"
    FOREIGN KEY ("device_id") REFERENCES "access_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_credential_sync" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "access_credential_sync";
CREATE POLICY tenant_isolation ON "access_credential_sync" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
