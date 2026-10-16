-- Favicon de la web pública del tenant (clave en el bucket público; null = el de TrasterOS).
ALTER TABLE "tenants" ADD COLUMN "web_favicon_key" TEXT;
