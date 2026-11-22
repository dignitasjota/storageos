-- Mejoras de Métricas y Finanzas del panel super admin.

-- Previsiones de MRR guardadas cada mes (para medir su precisión después).
CREATE TABLE "mrr_forecasts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Día 1 del mes en que se hizo la previsión.
  "made_month" DATE NOT NULL,
  -- Día 1 del mes previsto.
  "target_month" DATE NOT NULL,
  "months_ahead" INTEGER NOT NULL,
  "base_mrr" DECIMAL(12,2) NOT NULL,
  "prudent" DECIMAL(12,2) NOT NULL,
  "expected" DECIMAL(12,2) NOT NULL,
  "optimistic" DECIMAL(12,2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "mrr_forecasts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mrr_forecasts_made_target_key" ON "mrr_forecasts" ("made_month", "target_month");
CREATE INDEX "mrr_forecasts_target_idx" ON "mrr_forecasts" ("target_month");
REVOKE ALL ON "mrr_forecasts" FROM storageos_app;

-- Costes estimados para el margen (un solo registro).
CREATE TABLE "platform_finance_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "stripe_fee_pct" DECIMAL(6,3) NOT NULL DEFAULT 1.5,
  "stripe_fee_fixed" DECIMAL(8,3) NOT NULL DEFAULT 0.25,
  "redsys_fee_pct" DECIMAL(6,3) NOT NULL DEFAULT 0.4,
  "redsys_fee_fixed" DECIMAL(8,3) NOT NULL DEFAULT 0,
  "sepa_fee_pct" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "sepa_fee_fixed" DECIMAL(8,3) NOT NULL DEFAULT 0.3,
  "manual_fee_pct" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "manual_fee_fixed" DECIMAL(8,3) NOT NULL DEFAULT 0,
  "usd_eur_rate" DECIMAL(8,4) NOT NULL DEFAULT 0.92,
  "email_cost" DECIMAL(10,5) NOT NULL DEFAULT 0.001,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_finance_settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "platform_finance_settings" DEFAULT VALUES;
REVOKE ALL ON "platform_finance_settings" FROM storageos_app;

-- Gasto de marketing de la plataforma por mes (para el coste de adquisición).
CREATE TABLE "platform_marketing_spend" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- «AAAA-MM».
  "month" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "note" TEXT,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_marketing_spend_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_marketing_spend_month_key" ON "platform_marketing_spend" ("month");
REVOKE ALL ON "platform_marketing_spend" FROM storageos_app;

-- Anotaciones e hitos que se pintan en los gráficos mensuales.
CREATE TABLE "platform_metric_annotations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "date" DATE NOT NULL,
  "text" TEXT NOT NULL,
  "author_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_metric_annotations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_metric_annotations_author_id_fkey" FOREIGN KEY ("author_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_metric_annotations_date_idx" ON "platform_metric_annotations" ("date");
REVOKE ALL ON "platform_metric_annotations" FROM storageos_app;

-- Aviso de concentración de ingresos: un cliente por encima de este % del MRR.
ALTER TABLE "platform_alert_settings"
  ADD COLUMN "alert_concentration_pct" INTEGER NOT NULL DEFAULT 25;

-- Objetivo de cobro mensual (con IVA).
ALTER TABLE "platform_business_goals"
  ADD COLUMN "collected_target_monthly" DECIMAL(12,2);
