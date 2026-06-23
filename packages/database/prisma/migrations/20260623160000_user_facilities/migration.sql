-- Permisos por local: a qué locales (facilities) está restringido un usuario.
-- Sin filas para un usuario = sin restricción (ve todos los locales del tenant).
-- Con filas = solo ve/gestiona esos locales.

CREATE TABLE "user_facilities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "facility_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "user_facilities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_facilities_user_id_facility_id_key" ON "user_facilities"("user_id", "facility_id");
CREATE INDEX "user_facilities_tenant_id_user_id_idx" ON "user_facilities"("tenant_id", "user_id");
ALTER TABLE "user_facilities"
  ADD CONSTRAINT "user_facilities_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_facilities"
  ADD CONSTRAINT "user_facilities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_facilities"
  ADD CONSTRAINT "user_facilities_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_facilities" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "user_facilities";
CREATE POLICY tenant_isolation ON "user_facilities" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
