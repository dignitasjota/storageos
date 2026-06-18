-- RBAC v1: roles personalizados por tenant.

CREATE TABLE "tenant_roles" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "base_role" "user_role" NOT NULL DEFAULT 'staff',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tenant_roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_roles_tenant_id_name_key" ON "tenant_roles"("tenant_id", "name");
CREATE INDEX "tenant_roles_tenant_id_idx" ON "tenant_roles"("tenant_id");

ALTER TABLE "tenant_roles"
  ADD CONSTRAINT "tenant_roles_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_roles" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_roles";
CREATE POLICY tenant_isolation ON "tenant_roles"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Asignación del rol custom al usuario (nullable; SET NULL al borrar el rol).
ALTER TABLE "users" ADD COLUMN "tenant_role_id" UUID;
ALTER TABLE "users"
  ADD CONSTRAINT "users_tenant_role_id_fkey"
  FOREIGN KEY ("tenant_role_id") REFERENCES "tenant_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "users_tenant_role_id_idx" ON "users"("tenant_role_id");
