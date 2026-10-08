-- SEO de la web de TrasterOS: título/descripción, verificaciones, GA4, indexable
-- (null = por defecto) e imagen para compartir en redes.
ALTER TABLE "platform_website" ADD COLUMN "seo" JSONB;
ALTER TABLE "platform_website" ADD COLUMN "og_image_key" TEXT;
