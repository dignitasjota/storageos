-- Objetivos del negocio (un único registro, global).
CREATE TABLE "platform_business_goals" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "mrr_target" DECIMAL(12,2),
  "signups_target_monthly" INTEGER,
  "trial_conversion_target_pct" INTEGER,
  "target_date" DATE,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_business_goals_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_business_goals" FROM storageos_app;

-- Avisos de negocio en el resumen semanal y por chat.
ALTER TABLE "platform_alert_settings"
  ADD COLUMN "business_alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "alert_mrr_drop_pct" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "alert_churn_pct" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "alert_ai_cost_usd_week" DECIMAL(10,2) NOT NULL DEFAULT 20,
  ADD COLUMN "alert_big_tenant_mrr" DECIMAL(10,2) NOT NULL DEFAULT 100;

-- Foto mensual de la salud de cada tenant (para ver si sube o baja).
CREATE TABLE "tenant_health_snapshots" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "month" DATE NOT NULL,
  "score" INTEGER NOT NULL,
  "level" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_health_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_health_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tenant_health_snapshots_tenant_id_month_key"
  ON "tenant_health_snapshots"("tenant_id", "month");
CREATE INDEX "tenant_health_snapshots_month_idx" ON "tenant_health_snapshots"("month");
REVOKE ALL ON "tenant_health_snapshots" FROM storageos_app;
