-- Plan 3: firma electrónica simple + move-in self-service.

-- Tokens de firma remota en el contrato.
ALTER TABLE "contracts"
  ADD COLUMN "signing_token_hash" TEXT,
  ADD COLUMN "signing_token_expires_at" TIMESTAMPTZ(6);

-- Registro probatorio de la firma electrónica.
CREATE TABLE "contract_signatures" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "contract_id" UUID NOT NULL,
  "signer_name" TEXT NOT NULL,
  "signer_email" TEXT,
  "method" TEXT NOT NULL,
  "signature_image" TEXT,
  "typed_signature" TEXT,
  "document_hash" TEXT NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "channel" TEXT NOT NULL DEFAULT 'remote',
  "signed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "contract_signatures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contract_signatures_tenant_id_idx" ON "contract_signatures"("tenant_id");
CREATE INDEX "contract_signatures_contract_id_idx" ON "contract_signatures"("contract_id");

ALTER TABLE "contract_signatures"
  ADD CONSTRAINT "contract_signatures_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_signatures"
  ADD CONSTRAINT "contract_signatures_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: aislamiento por tenant (igual que el resto de tablas de negocio).
ALTER TABLE "contract_signatures" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "contract_signatures";
CREATE POLICY tenant_isolation ON "contract_signatures"
    FOR ALL
    TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
