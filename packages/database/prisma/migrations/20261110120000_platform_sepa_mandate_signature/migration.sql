-- Mandato SEPA de los tenants a la plataforma firmado con constancia (contrato
-- de adeudos del banco, 4.3) y preaviso pactado en él (4.1: 5 días, decisión de
-- Jota). Los mandatos que ya existen quedan como «firmados fuera» (`external`).

ALTER TABLE "platform_sepa_settings"
  ADD COLUMN "creditor_address" TEXT,
  ADD COLUMN "creditor_postal_code" TEXT,
  ADD COLUMN "creditor_city" TEXT,
  ADD COLUMN "creditor_country" TEXT NOT NULL DEFAULT 'ES',
  ADD COLUMN "prenotice_days" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "platform_sepa_mandates"
  ADD COLUMN "signature_status" TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN "debtor_name" TEXT,
  ADD COLUMN "debtor_address" TEXT,
  ADD COLUMN "debtor_postal_code" TEXT,
  ADD COLUMN "debtor_city" TEXT,
  ADD COLUMN "debtor_country" TEXT,
  ADD COLUMN "signer_name" TEXT,
  ADD COLUMN "signer_user_id" UUID,
  ADD COLUMN "signature_method" TEXT,
  ADD COLUMN "signature_image" TEXT,
  ADD COLUMN "typed_signature" TEXT,
  ADD COLUMN "document_text" TEXT,
  ADD COLUMN "document_hash" TEXT,
  ADD COLUMN "signed_ip" TEXT,
  ADD COLUMN "signed_user_agent" TEXT,
  ADD COLUMN "signed_at_ts" TIMESTAMPTZ(6);

-- Constancia del preaviso de cada cargo de la remesa de la plataforma.
ALTER TABLE "platform_sepa_remittance_items"
  ADD COLUMN "prenotice_sent_at" TIMESTAMPTZ(6),
  ADD COLUMN "prenotice_recipients" TEXT;
