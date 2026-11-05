-- «Hoy» del panel del tenant: avisos apartados por el equipo y resumen diario
-- a medida de cada persona (hora, locales y push).

CREATE TABLE "today_snoozes" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "ref_id" UUID NOT NULL,
  "label" TEXT,
  "until" TIMESTAMPTZ(6) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "today_snoozes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "today_snoozes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "today_snoozes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "today_snoozes_tenant_id_kind_ref_id_key" ON "today_snoozes"("tenant_id", "kind", "ref_id");
CREATE INDEX "today_snoozes_tenant_id_until_idx" ON "today_snoozes"("tenant_id", "until");

ALTER TABLE "today_snoozes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "today_snoozes" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "today_snoozes" TO storageos_app;

ALTER TABLE "users"
  ADD COLUMN "daily_summary_prefs" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "daily_summary_last_date" DATE;
