-- App de Meta propia del tenant (mientras no haya alta con coexistencia): los
-- avisos de su número llegan firmados con el secreto de SU app y la verificación
-- del webhook usa un token propio que se le genera aquí.
ALTER TABLE "tenant_whatsapp_settings"
  ADD COLUMN "app_secret_encrypted" TEXT,
  ADD COLUMN "webhook_verify_token_encrypted" TEXT,
  ADD COLUMN "webhook_verify_token_hash" TEXT;

CREATE UNIQUE INDEX "tenant_whatsapp_settings_verify_token_key"
  ON "tenant_whatsapp_settings" ("webhook_verify_token_hash")
  WHERE "webhook_verify_token_hash" IS NOT NULL;
