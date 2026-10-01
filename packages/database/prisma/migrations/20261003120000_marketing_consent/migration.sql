-- Comunicaciones comerciales (campañas, win-back): LSSI art. 21.
-- Clientes: se les puede escribir mientras no se den de baja.
ALTER TABLE "customers" ADD COLUMN "marketing_opt_out_at" TIMESTAMPTZ(6);
-- Leads (aún no son clientes): solo con consentimiento expreso, y hasta que se den de baja.
ALTER TABLE "leads" ADD COLUMN "marketing_consent_at" TIMESTAMPTZ(6);
ALTER TABLE "leads" ADD COLUMN "marketing_opt_out_at" TIMESTAMPTZ(6);
-- Envío comercial: lleva enlace y cabecera de baja, y se omite si el destinatario se dio de baja.
ALTER TABLE "communications" ADD COLUMN "is_marketing" BOOLEAN NOT NULL DEFAULT false;

-- El widget ya pedía el consentimiento, pero solo se guardaba en `metadata`.
UPDATE "leads"
SET "marketing_consent_at" = "created_at"
WHERE "metadata"->>'acceptsMarketing' = 'true' AND "marketing_consent_at" IS NULL;
