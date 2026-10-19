-- Señales de interés: un usuario del tenant entra en una función que su plan no
-- incluye (ve la pantalla «no está en tu plan»). Para detectar a quién ofrecer
-- cada extra.
CREATE TABLE "feature_interest_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID,
  "feature" TEXT NOT NULL,
  "path" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "feature_interest_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feature_interest_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "feature_interest_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "feature_interest_events_tenant_feature_idx" ON "feature_interest_events" ("tenant_id", "feature", "created_at");
CREATE INDEX "feature_interest_events_created_idx" ON "feature_interest_events" ("created_at");

ALTER TABLE "feature_interest_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "feature_interest_events" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
