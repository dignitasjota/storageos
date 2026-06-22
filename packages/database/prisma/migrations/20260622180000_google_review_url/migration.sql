-- Crecimiento/SEO: tras una valoración NPS positiva (promotor), invitar al
-- inquilino a dejar una reseña en Google Business Profile (link directo del
-- tenant) para mejorar el ranking local y la captación orgánica.

ALTER TABLE "tenants" ADD COLUMN "google_review_url" TEXT;
