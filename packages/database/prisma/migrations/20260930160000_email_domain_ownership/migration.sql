-- Prueba de propiedad del dominio POR TENANT: todos los dominios viven en la
-- misma cuenta Brevo de la plataforma, y Brevo solo prueba que los DNS apuntan
-- a esa cuenta, no a qué tenant pertenece el dominio. El tenant debe publicar
-- `_trasteros.<dominio>` TXT `trasteros-verification=<ownership_token>`.
ALTER TABLE "tenant_email_domains"
  ADD COLUMN "ownership_token" TEXT,
  ADD COLUMN "ownership_verified_at" TIMESTAMPTZ(6);

UPDATE "tenant_email_domains"
  SET "ownership_token" = md5(random()::text || id::text || clock_timestamp()::text);

-- Los dominios ya verificados antes de este cambio se consideran propios
-- (solo existían los del operador de la plataforma).
UPDATE "tenant_email_domains"
  SET "ownership_verified_at" = "verified_at"
  WHERE "status" = 'verified';

ALTER TABLE "tenant_email_domains" ALTER COLUMN "ownership_token" SET NOT NULL;
