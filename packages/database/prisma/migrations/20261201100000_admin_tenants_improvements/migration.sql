-- Mejoras del apartado Tenants del panel admin.

-- Vistas guardadas de las listas del panel admin (por super admin). Global:
-- solo la usa el panel admin, sin acceso del rol de la app.
CREATE TABLE "super_admin_saved_views" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "super_admin_id" UUID NOT NULL,
  "page" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "filters" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "super_admin_saved_views_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "super_admin_saved_views_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "super_admin_saved_views_admin_page_name_key"
  ON "super_admin_saved_views" ("super_admin_id", "page", "name");
REVOKE ALL ON TABLE "super_admin_saved_views" FROM storageos_app;

-- Super admin que se encarga de un seguimiento.
ALTER TABLE "tenant_followups" ADD COLUMN "assigned_to_id" UUID;
ALTER TABLE "tenant_followups" ADD CONSTRAINT "tenant_followups_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tenant_followups_assigned_to_id_idx" ON "tenant_followups" ("assigned_to_id");

-- «Ignorar» un tenant en la lista de riesgo hasta una fecha.
ALTER TABLE "tenants"
  ADD COLUMN "risk_snoozed_until" TIMESTAMPTZ(6),
  ADD COLUMN "risk_snooze_reason" TEXT;
