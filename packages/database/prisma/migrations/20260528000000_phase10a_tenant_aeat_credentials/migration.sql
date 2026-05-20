-- Fase 10A.1: certificado digital PKCS#12 del tenant para Veri*Factu.
-- Una sola credencial activa por tenant (UNIQUE). El p12 viaja cifrado
-- con AES-256-GCM (CryptoService, MASTER_ENCRYPTION_KEY).

-- CreateTable
CREATE TABLE "tenant_aeat_credentials" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "cert_p12_encrypted" BYTEA NOT NULL,
    "cert_password_encrypted" TEXT NOT NULL,
    "cert_common_name" TEXT NOT NULL,
    "cert_nif" TEXT NOT NULL,
    "cert_issuer" TEXT NOT NULL,
    "cert_valid_from" TIMESTAMPTZ(6) NOT NULL,
    "cert_valid_to" TIMESTAMPTZ(6) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "tenant_aeat_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_aeat_credentials_tenant_id_key" ON "tenant_aeat_credentials"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_aeat_credentials_tenant_id_revoked_at_idx" ON "tenant_aeat_credentials"("tenant_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "tenant_aeat_credentials"
    ADD CONSTRAINT "tenant_aeat_credentials_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_aeat_credentials"
    ADD CONSTRAINT "tenant_aeat_credentials_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS: aislamiento por tenant_id usando el contexto de sesion.
-- (Los permisos al rol storageos_app vienen de ALTER DEFAULT PRIVILEGES
-- definido en 20260518230200_phase1a_app_role.)
ALTER TABLE "tenant_aeat_credentials" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_aeat_credentials";
CREATE POLICY tenant_isolation ON "tenant_aeat_credentials"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
