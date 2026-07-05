-- Emails automáticos de ciclo de vida al tenant (bienvenida, trial por expirar,
-- pago fallido). Registro de idempotencia por (tenant, tipo) + config junto a
-- las alertas de plataforma (singleton `platform_alert_settings`).

-- Tabla global (sin RLS, como las platform_*): un email de cada tipo por tenant.
CREATE TABLE "tenant_lifecycle_emails" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tenant_lifecycle_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_lifecycle_emails_tenant_id_type_key"
    ON "tenant_lifecycle_emails"("tenant_id", "type");

CREATE INDEX "tenant_lifecycle_emails_tenant_id_idx"
    ON "tenant_lifecycle_emails"("tenant_id");

ALTER TABLE "tenant_lifecycle_emails"
    ADD CONSTRAINT "tenant_lifecycle_emails_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Config de los emails de ciclo de vida: vive junto a las alertas de plataforma
-- para no duplicar singleton ni página de admin.
ALTER TABLE "platform_alert_settings"
    ADD COLUMN "lifecycle_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "send_welcome" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "send_trial_reminders" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "send_past_due" BOOLEAN NOT NULL DEFAULT true;
