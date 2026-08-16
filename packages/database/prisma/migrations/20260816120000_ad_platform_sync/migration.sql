-- Sincronización automática de gasto publicitario (Google Ads / Meta Ads):
-- credenciales por tenant (pegadas a mano por el propio tenant, cifradas) +
-- vínculo de un canal de marketing a una campaña externa + idempotencia del
-- gasto sincronizado.

CREATE TABLE "google_ads_settings" (
  "id"                       UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id"                UUID NOT NULL,
  "client_id"                TEXT,
  "client_secret_encrypted"  TEXT,
  "developer_token_encrypted" TEXT,
  "refresh_token_encrypted"  TEXT,
  "customer_id"              TEXT,
  "login_customer_id"        TEXT,
  "enabled"                  BOOLEAN NOT NULL DEFAULT false,
  "last_sync_at"             TIMESTAMPTZ(6),
  "last_error"               TEXT,
  "created_at"                TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"                TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "google_ads_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "google_ads_settings_tenant_id_key" ON "google_ads_settings"("tenant_id");

ALTER TABLE "google_ads_settings"
  ADD CONSTRAINT "google_ads_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "google_ads_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "google_ads_settings";
CREATE POLICY tenant_isolation ON "google_ads_settings"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "meta_ads_settings" (
  "id"                    UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id"             UUID NOT NULL,
  "access_token_encrypted" TEXT,
  "ad_account_id"         TEXT,
  "enabled"               BOOLEAN NOT NULL DEFAULT false,
  "last_sync_at"          TIMESTAMPTZ(6),
  "last_error"            TEXT,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "meta_ads_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_ads_settings_tenant_id_key" ON "meta_ads_settings"("tenant_id");

ALTER TABLE "meta_ads_settings"
  ADD CONSTRAINT "meta_ads_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_ads_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "meta_ads_settings";
CREATE POLICY tenant_isolation ON "meta_ads_settings"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Vínculo del canal a una campaña externa (el `type` del canal ya dice la
-- plataforma: google_ads | meta_ads). Sin campaña vinculada, el canal sigue
-- funcionando como hasta ahora (coste manual vía gasto vinculado).
ALTER TABLE "marketing_channels" ADD COLUMN "external_campaign_id" TEXT;

-- Idempotencia del gasto sincronizado automáticamente: `<plataforma>:<id de
-- campaña>:<fecha>` — re-sincronizar el mismo rango actualiza en vez de
-- duplicar.
ALTER TABLE "expenses" ADD COLUMN "external_ref" TEXT;
CREATE UNIQUE INDEX "expenses_external_ref_key" ON "expenses"("external_ref") WHERE "external_ref" IS NOT NULL;
