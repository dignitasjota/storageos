-- Rendimiento diario de las campañas de Google Ads y Meta Ads vinculadas a un
-- canal de marketing (el gasto sigue yendo a `expenses`). Se rellena en la
-- misma sincronización que el gasto.
CREATE TABLE "ad_metrics_daily" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "marketing_channel_id" UUID NOT NULL,
  -- google_ads | meta_ads
  "platform" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  -- Conversiones que cuenta la plataforma (Google puede dar fracciones).
  "conversions" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ad_metrics_daily_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ad_metrics_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "ad_metrics_daily_channel_fkey" FOREIGN KEY ("marketing_channel_id") REFERENCES "marketing_channels"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "ad_metrics_daily_channel_date_key" ON "ad_metrics_daily" ("marketing_channel_id", "date");
CREATE INDEX "ad_metrics_daily_tenant_date_idx" ON "ad_metrics_daily" ("tenant_id", "date");

ALTER TABLE "ad_metrics_daily" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ad_metrics_daily" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
