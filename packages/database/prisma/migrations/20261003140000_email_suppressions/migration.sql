-- Lista de supresión de correo. Los proveedores aceptan un envío y lo rebotan
-- después; seguir escribiendo a una dirección que no existe (o que nos marca
-- como spam) daña la reputación de la cuenta de envío, que es compartida por
-- todos los tenants.
--
-- - tenant_id NULL + scope 'all': rebote permanente / email inválido /
--   bloqueado por el proveedor → no se le envía nada, desde ningún tenant.
-- - tenant_id + scope 'marketing': queja de spam → ese tenant no le envía más
--   comunicaciones comerciales (los correos necesarios siguen saliendo).
CREATE TABLE "email_suppressions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "tenant_id" UUID,
  "scope" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "provider" TEXT,
  "detail" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_suppressions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "email_suppressions_email_tenant_key"
  ON "email_suppressions" ("email", "tenant_id") NULLS NOT DISTINCT;
CREATE INDEX "email_suppressions_created_at_idx" ON "email_suppressions" ("created_at");

-- Tabla global: el rol restringido de la app no la necesita (va por el rol admin).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storageos_app') THEN
    REVOKE ALL ON TABLE "email_suppressions" FROM storageos_app;
  END IF;
END $$;
