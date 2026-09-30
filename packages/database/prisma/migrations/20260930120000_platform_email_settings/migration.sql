-- Proveedor de correo de la plataforma elegido desde el panel del super admin
-- (singleton). `provider` NULL = el de la variable EMAIL_PROVIDER. Con
-- `fallback_enabled`, si el proveedor elegido falla se reintenta con el otro.
CREATE TABLE "platform_email_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "provider" TEXT,
  "fallback_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_email_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_email_settings_provider_check" CHECK ("provider" IS NULL OR "provider" IN ('brevo', 'resend'))
);

-- Tabla global: el rol restringido de la app no la necesita (va por el rol admin).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storageos_app') THEN
    REVOKE ALL ON TABLE "platform_email_settings" FROM storageos_app;
  END IF;
END $$;
