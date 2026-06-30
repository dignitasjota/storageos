-- Overrides de feature por tenant: el super admin activa/desactiva una feature
-- premium concreta para un tenant sin cambiarle el plan (cortesía, beta, legacy).
-- Sin RLS: es config de plataforma (la lee el FeatureGuard/auth con cliente admin).
CREATE TABLE "tenant_feature_overrides" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "feature" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tenant_feature_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_feature_overrides_tenant_feature_key"
    ON "tenant_feature_overrides" ("tenant_id", "feature");

ALTER TABLE "tenant_feature_overrides"
    ADD CONSTRAINT "tenant_feature_overrides_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_feature_overrides" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_feature_overrides";
CREATE POLICY tenant_isolation ON "tenant_feature_overrides" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
