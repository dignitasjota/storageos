-- Plan Administrador: un propietario puede subir su propio certificado para
-- Veri*Factu. Sin él, sus facturas se envían con el del tenant como
-- representante. owner_id null = certificado del tenant.
ALTER TABLE "tenant_aeat_credentials" ADD COLUMN "owner_id" UUID REFERENCES "owners"("id") ON DELETE RESTRICT;
CREATE INDEX "tenant_aeat_credentials_owner_idx" ON "tenant_aeat_credentials" ("tenant_id", "owner_id") WHERE "revoked_at" IS NULL;
