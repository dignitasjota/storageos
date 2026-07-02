-- White-label por dominio propio del tenant. El dominio se guarda en minúsculas
-- y es único a nivel de plataforma. `verified_at` no nulo = activo (el super
-- admin lo aprobó tras configurar el Proxy Host + SSL en NPM).
ALTER TABLE "tenants" ADD COLUMN "custom_domain" TEXT;
ALTER TABLE "tenants" ADD COLUMN "custom_domain_verified_at" TIMESTAMPTZ(6);
CREATE UNIQUE INDEX "tenants_custom_domain_key" ON "tenants" ("custom_domain");
