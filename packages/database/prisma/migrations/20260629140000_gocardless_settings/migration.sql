-- Config de GoCardless por tenant (domiciliación SEPA gestionada). Access token
-- + webhook secret cifrados AES-256-GCM (como redsys_settings / holded_settings).
CREATE TABLE "gocardless_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "access_token_encrypted" TEXT NOT NULL,
    "webhook_secret_encrypted" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'sandbox',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "gocardless_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gocardless_settings_tenant_id_key" ON "gocardless_settings" ("tenant_id");

ALTER TABLE "gocardless_settings"
    ADD CONSTRAINT "gocardless_settings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
