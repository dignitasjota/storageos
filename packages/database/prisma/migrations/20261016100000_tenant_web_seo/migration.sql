-- Título y descripción para Google de la web pública del tenant (portada,
-- /precios y /contacto), independientes del claim que se ve en la portada.
ALTER TABLE "tenants" ADD COLUMN "web_seo" JSONB NOT NULL DEFAULT '{}';
