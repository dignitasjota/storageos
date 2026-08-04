-- Copy editable de las secciones de las plantillas premium multisección
-- (onepage/escaparate): heroSubtitle, services[], advantages[], steps[].
ALTER TABLE "tenants" ADD COLUMN "web_content" JSONB NOT NULL DEFAULT '{}';
