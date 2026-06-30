-- White-label del portal del inquilino: color de marca + logo del operador.
ALTER TABLE "tenants" ADD COLUMN "portal_brand_color" TEXT;
ALTER TABLE "tenants" ADD COLUMN "portal_logo_url" TEXT;
