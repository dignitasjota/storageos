-- Web «Premium» v2: secciones activables de la web pública (testimonios, FAQ,
-- formulario de contacto). Flags en un jsonb para extensibilidad. Feature
-- `web_premium`; sin ella se ignoran.
ALTER TABLE "tenants"
  ADD COLUMN "web_sections" JSONB NOT NULL DEFAULT '{}';
