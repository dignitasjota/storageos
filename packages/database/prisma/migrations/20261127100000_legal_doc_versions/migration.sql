-- Versiones de los textos legales de la web del tenant que alguien ha aceptado
-- (hoy, las Condiciones Generales de Contratación). Inmutables: si el texto
-- cambia, se crea otra versión.
CREATE TABLE "legal_doc_versions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "doc" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "legal_doc_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_doc_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "legal_doc_versions_tenant_doc_version_key"
  ON "legal_doc_versions"("tenant_id", "doc", "version");
CREATE UNIQUE INDEX "legal_doc_versions_tenant_doc_hash_key"
  ON "legal_doc_versions"("tenant_id", "doc", "content_hash");

ALTER TABLE "legal_doc_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "legal_doc_versions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_doc_versions" TO storageos_app;

-- Quién aceptó qué versión, para qué contrato y desde dónde.
CREATE TABLE "legal_doc_acceptances" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "contract_id" UUID,
  "channel" TEXT NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "accepted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "legal_doc_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legal_doc_acceptances_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "legal_doc_acceptances_version_id_fkey" FOREIGN KEY ("version_id")
    REFERENCES "legal_doc_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "legal_doc_acceptances_customer_id_fkey" FOREIGN KEY ("customer_id")
    REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "legal_doc_acceptances_contract_id_fkey" FOREIGN KEY ("contract_id")
    REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "legal_doc_acceptances_contract_id_idx" ON "legal_doc_acceptances"("contract_id");
CREATE INDEX "legal_doc_acceptances_customer_id_idx" ON "legal_doc_acceptances"("customer_id");
CREATE INDEX "legal_doc_acceptances_version_id_idx" ON "legal_doc_acceptances"("version_id");

ALTER TABLE "legal_doc_acceptances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "legal_doc_acceptances" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_doc_acceptances" TO storageos_app;
