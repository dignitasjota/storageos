-- Control de marketing: catálogo de canales/campañas de captación (portales
-- inmobiliarios, Google/Meta Ads, publicidad física...) con coste vinculado
-- (expenses.marketing_channel_id) para calcular coste-por-lead/CAC/ROI por
-- canal, más un enlace corto con contador de clics para campañas físicas
-- (carteles/flyers) y un vínculo opcional a una promoción para atribución
-- offline.
CREATE TABLE "marketing_channels" (
    "id"                UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id"         UUID NOT NULL,
    "facility_id"       UUID,
    "promotion_id"      UUID,
    -- real_estate_portal | google_ads | meta_ads | physical | referral_program | other
    "type"              TEXT NOT NULL DEFAULT 'other',
    "name"              TEXT NOT NULL,
    -- active | paused | ended
    "status"            TEXT NOT NULL DEFAULT 'active',
    "external_url"      TEXT,
    "monthly_cost"      DECIMAL(10,2),
    "renews_on"         DATE,
    -- valor de leads.source / leads.utm_source que se atribuye a este canal.
    "utm_source_match"  TEXT,
    "short_code"        TEXT,
    "click_count"       INTEGER NOT NULL DEFAULT 0,
    "notes"             TEXT,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "deleted_at"        TIMESTAMPTZ(6),
    CONSTRAINT "marketing_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_channels_short_code_key" ON "marketing_channels" ("short_code");
CREATE INDEX "marketing_channels_tenant_status_idx" ON "marketing_channels" ("tenant_id", "status");

ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_promotion_id_fkey"
    FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "marketing_channels" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "marketing_channels";
CREATE POLICY tenant_isolation ON "marketing_channels" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Gasto vinculado a un canal de marketing (opcional): permite calcular el
-- coste real de cada canal a partir de los `expenses` de categoría marketing.
ALTER TABLE "expenses" ADD COLUMN "marketing_channel_id" UUID;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_marketing_channel_id_fkey"
    FOREIGN KEY ("marketing_channel_id") REFERENCES "marketing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "expenses_marketing_channel_id_idx" ON "expenses" ("marketing_channel_id");

-- Igual para la plantilla de gasto recurrente (p. ej. la cuota mensual de un
-- portal inmobiliario) — se propaga a cada `expense` generado por el cron.
ALTER TABLE "recurring_expenses" ADD COLUMN "marketing_channel_id" UUID;
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_marketing_channel_id_fkey"
    FOREIGN KEY ("marketing_channel_id") REFERENCES "marketing_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "recurring_expenses_marketing_channel_id_idx" ON "recurring_expenses" ("marketing_channel_id");
