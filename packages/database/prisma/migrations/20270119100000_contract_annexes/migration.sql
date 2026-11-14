-- Anexos a un contrato firmado: texto que el inquilino firma aparte, con su
-- huella y la evidencia de la firma (como el contrato).
CREATE TABLE contract_annexes (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  contract_id              UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  number                   INTEGER NOT NULL,
  title                    TEXT NOT NULL,
  body                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  terms_text               TEXT NOT NULL,
  document_hash            TEXT NOT NULL,
  created_by_user_id       UUID,
  signing_token_hash       TEXT,
  signing_token_expires_at TIMESTAMPTZ(6),
  sent_to                  TEXT,
  signed_at                TIMESTAMPTZ(6),
  signer_name              TEXT,
  signature_method         TEXT,
  signature_image          TEXT,
  typed_signature          TEXT,
  ip_address               TEXT,
  user_agent               TEXT,
  channel                  TEXT,
  pdf_key                  TEXT,
  cancelled_at             TIMESTAMPTZ(6),
  created_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE (contract_id, number)
);
CREATE INDEX contract_annexes_tenant_id_idx ON contract_annexes (tenant_id);

ALTER TABLE contract_annexes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_annexes FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON contract_annexes TO storageos_app;
