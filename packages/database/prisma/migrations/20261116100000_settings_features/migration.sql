-- Revisión de Configuración (PR B).

-- Contacto del negocio: respaldo cuando un local no tiene el suyo.
ALTER TABLE "tenants" ADD COLUMN "contact_phone" TEXT;
ALTER TABLE "tenants" ADD COLUMN "contact_email" TEXT;
-- Cuándo avisó el tenant de que el DNS de su dominio ya apunta a la plataforma.
ALTER TABLE "tenants" ADD COLUMN "custom_domain_ready_at" TIMESTAMPTZ(6);

-- Cambio del email de acceso: el nuevo se confirma con un enlace.
ALTER TABLE "users" ADD COLUMN "pending_email" TEXT;
ALTER TABLE "users" ADD COLUMN "email_change_token_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "email_change_expires_at" TIMESTAMPTZ(6);
