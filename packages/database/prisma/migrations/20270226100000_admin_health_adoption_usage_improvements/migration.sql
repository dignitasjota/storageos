-- Mejoras de Salud, Adopción y Uso del panel super admin.

-- Último día (hora de España) en que el usuario usó el panel: evita escribir
-- más de una vez al día en `tenant_activity_days`.
ALTER TABLE "users" ADD COLUMN "last_active_day" DATE;

-- Días en que cada usuario del equipo usó el panel (inicio de sesión o sesión
-- renovada). Una fila por usuario y día.
CREATE TABLE "tenant_activity_days" (
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  CONSTRAINT "tenant_activity_days_pkey" PRIMARY KEY ("user_id", "day"),
  CONSTRAINT "tenant_activity_days_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_activity_days_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tenant_activity_days_tenant_day_idx" ON "tenant_activity_days" ("tenant_id", "day");
REVOKE ALL ON "tenant_activity_days" FROM storageos_app;

-- Foto diaria de la salud de cada tenant (historial y aviso de caída).
CREATE TABLE "tenant_health_daily" (
  "tenant_id" UUID NOT NULL,
  "day" DATE NOT NULL,
  "score" INTEGER NOT NULL,
  "level" TEXT NOT NULL,
  "segment" TEXT NOT NULL,
  CONSTRAINT "tenant_health_daily_pkey" PRIMARY KEY ("tenant_id", "day"),
  CONSTRAINT "tenant_health_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tenant_health_daily_day_idx" ON "tenant_health_daily" ("day");
REVOKE ALL ON "tenant_health_daily" FROM storageos_app;

-- Ajustes de Salud y Uso (un solo registro): pesos de los factores, aviso de
-- caída y umbrales del consumo anómalo.
CREATE TABLE "platform_health_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "client_weights" JSONB NOT NULL DEFAULT '{"engagement":30,"billing":20,"subscription":20,"adoption":15,"portal":10,"support":5}',
  "trial_weights" JSONB NOT NULL DEFAULT '{"facility":15,"units":15,"customer":15,"contract":25,"invoice":15,"team":15}',
  "drop_alert_points" INTEGER NOT NULL DEFAULT 15,
  "anomaly_multiplier" DECIMAL(6,2) NOT NULL DEFAULT 3,
  "anomaly_min_emails" INTEGER NOT NULL DEFAULT 500,
  "anomaly_min_ai_usd" DECIMAL(10,2) NOT NULL DEFAULT 5,
  "anomaly_min_storage_mb" INTEGER NOT NULL DEFAULT 1024,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_health_settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "platform_health_settings" DEFAULT VALUES;
REVOKE ALL ON "platform_health_settings" FROM storageos_app;

-- Almacenamiento de cada tenant al cerrar cada mes (lo guarda la medición diaria).
CREATE TABLE "tenant_storage_usage_history" (
  "tenant_id" UUID NOT NULL,
  -- Día 1 del mes (hora de España).
  "month" DATE NOT NULL,
  "bytes" BIGINT NOT NULL DEFAULT 0,
  "objects" INTEGER NOT NULL DEFAULT 0,
  "by_bucket" JSONB NOT NULL DEFAULT '{}',
  "measured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_storage_usage_history_pkey" PRIMARY KEY ("tenant_id", "month"),
  CONSTRAINT "tenant_storage_usage_history_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tenant_storage_usage_history_month_idx" ON "tenant_storage_usage_history" ("month");
REVOKE ALL ON "tenant_storage_usage_history" FROM storageos_app;

-- La medición que ya había pasa a ser la del mes en que se hizo.
INSERT INTO "tenant_storage_usage_history" ("tenant_id", "month", "bytes", "objects", "by_bucket", "measured_at")
SELECT "tenant_id",
       date_trunc('month', "measured_at" AT TIME ZONE 'Europe/Madrid')::date,
       "bytes", "objects", "by_bucket", "measured_at"
FROM "tenant_storage_usage"
ON CONFLICT DO NOTHING;
