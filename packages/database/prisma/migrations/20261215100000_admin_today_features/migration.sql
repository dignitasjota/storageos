-- Mejoras de «Hoy» del panel admin.

-- Avisos que el equipo aparta unos días.
CREATE TABLE "admin_today_snoozes" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "kind" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "label" TEXT,
  "until" TIMESTAMPTZ(6) NOT NULL,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "admin_today_snoozes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_today_snoozes_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "admin_today_snoozes_kind_ref_key" ON "admin_today_snoozes" ("kind", "ref");
REVOKE ALL ON admin_today_snoozes FROM storageos_app;

-- Avisos al momento de lo urgente que aparece.
ALTER TABLE "platform_alert_settings"
  ADD COLUMN "instant_alerts_enabled" BOOLEAN NOT NULL DEFAULT true;
