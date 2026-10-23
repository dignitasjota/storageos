-- Firma del mandato SEPA por el deudor con su constancia (contrato de adeudos
-- del banco, cláusula 4.3: no se puede cobrar sin mandato firmado y hay que
-- conservarlo mientras pueda reclamar). Domicilio del acreedor (sale en el
-- mandato). Los mandatos que ya existen quedan como «firmados fuera» (`external`):
-- el tenant o la plataforma los tiene en papel o los migró.

ALTER TABLE "sepa_settings"
  ADD COLUMN "creditor_address" TEXT,
  ADD COLUMN "creditor_postal_code" TEXT,
  ADD COLUMN "creditor_city" TEXT,
  ADD COLUMN "creditor_country" TEXT NOT NULL DEFAULT 'ES';

ALTER TABLE "sepa_mandates"
  ADD COLUMN "signature_status" TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN "signing_token_hash" TEXT,
  ADD COLUMN "signing_token_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "debtor_name" TEXT,
  ADD COLUMN "debtor_address" TEXT,
  ADD COLUMN "debtor_postal_code" TEXT,
  ADD COLUMN "debtor_city" TEXT,
  ADD COLUMN "debtor_country" TEXT,
  ADD COLUMN "signer_name" TEXT,
  ADD COLUMN "signature_method" TEXT,
  ADD COLUMN "signature_image" TEXT,
  ADD COLUMN "typed_signature" TEXT,
  ADD COLUMN "document_text" TEXT,
  ADD COLUMN "document_hash" TEXT,
  ADD COLUMN "signed_ip" TEXT,
  ADD COLUMN "signed_user_agent" TEXT,
  ADD COLUMN "signed_at_ts" TIMESTAMPTZ(6);
