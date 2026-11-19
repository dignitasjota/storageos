-- Mejoras de Mercado (Competencia y Posiciones en Google).

-- Competencia: cada cuántos días se revisa cada competidor y hasta cuándo dura
-- su promoción (después no cuenta en el precio comparable).
ALTER TABLE "competitor_facilities"
  ADD COLUMN "review_every_days" INTEGER,
  ADD COLUMN "promo_ends_at" DATE;

-- Histórico de las promociones de cada competidor.
CREATE TABLE "competitor_promotions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "competitor_facility_id" UUID NOT NULL,
  "description" TEXT,
  "free_months" INTEGER,
  "discount_pct" INTEGER,
  "discount_months" INTEGER,
  "ends_at" DATE,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ended_at" TIMESTAMPTZ(6),
  CONSTRAINT "competitor_promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "competitor_promotions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "competitor_promotions_facility_fkey" FOREIGN KEY ("competitor_facility_id") REFERENCES "competitor_facilities"("id") ON DELETE CASCADE
);
CREATE INDEX "competitor_promotions_facility_idx" ON "competitor_promotions" ("competitor_facility_id", "started_at");
-- La promoción que ya tenía cada competidor entra como la primera.
INSERT INTO "competitor_promotions" ("tenant_id", "competitor_facility_id", "description", "free_months", "discount_pct", "discount_months", "started_at")
SELECT "tenant_id", "id", "current_promotion", "promo_free_months", "promo_discount_pct", "promo_discount_months", "updated_at"
FROM "competitor_facilities"
WHERE "current_promotion" IS NOT NULL
   OR COALESCE("promo_free_months", 0) > 0
   OR COALESCE("promo_discount_pct", 0) > 0;

-- Posiciones en Google: búsquedas con la marca, quién recibe el informe y
-- cuándo se avisó por última vez de una caída.
ALTER TABLE "tenant_search_console"
  ADD COLUMN "brand_terms" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "report_recipient_ids" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "last_drop_alert_at" TIMESTAMPTZ(6);

-- Búsquedas que el negocio sigue, con la posición a la que quiere llegar.
CREATE TABLE "seo_tracked_keywords" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "keyword" TEXT NOT NULL,
  "target_position" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_tracked_keywords_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_tracked_keywords_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "seo_tracked_keywords_key" ON "seo_tracked_keywords" ("tenant_id", lower("keyword"));

-- Totales de cada día por dispositivo (móvil, ordenador, tableta).
CREATE TABLE "search_console_devices" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "date" DATE NOT NULL,
  "device" TEXT NOT NULL,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "position" DECIMAL(7,2) NOT NULL,
  CONSTRAINT "search_console_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "search_console_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "search_console_devices_key" ON "search_console_devices" ("tenant_id", "date", "device");

ALTER TABLE "competitor_promotions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "competitor_promotions" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "seo_tracked_keywords" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_tracked_keywords" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "search_console_devices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search_console_devices" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
