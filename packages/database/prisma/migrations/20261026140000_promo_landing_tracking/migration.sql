-- Landings de promoción (PR 2): canales de marketing que llevan a una landing
-- y visitas por origen.
ALTER TABLE "marketing_channels" ADD COLUMN "promo_landing_id" UUID;
ALTER TABLE "marketing_channels" ADD CONSTRAINT "marketing_channels_promo_landing_id_fkey"
  FOREIGN KEY ("promo_landing_id") REFERENCES "promo_landings"("id") ON DELETE SET NULL;
CREATE INDEX "marketing_channels_promo_landing_idx" ON "marketing_channels" ("promo_landing_id");

-- Una visita a una landing. Sin IP ni datos personales: un identificador
-- aleatorio del navegador (para contar visitantes) y las variables de la URL.
CREATE TABLE "promo_landing_visits" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "promo_landing_id" UUID NOT NULL,
  "visitor_id" TEXT NOT NULL,
  "source" TEXT,
  "medium" TEXT,
  "campaign" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "promo_landing_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promo_landing_visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "promo_landing_visits_promo_landing_id_fkey" FOREIGN KEY ("promo_landing_id") REFERENCES "promo_landings"("id") ON DELETE CASCADE
);
CREATE INDEX "promo_landing_visits_landing_created_idx" ON "promo_landing_visits" ("promo_landing_id", "created_at");

ALTER TABLE "promo_landing_visits" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promo_landing_visits" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
