-- SEO técnico de la web pública: verificación de Google Search Console +
-- Measurement ID de Google Analytics 4. Sin gating por `web_premium`.
ALTER TABLE "tenants"
  ADD COLUMN "google_site_verification" TEXT,
  ADD COLUMN "google_analytics_id" TEXT;
