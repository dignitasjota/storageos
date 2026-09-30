-- Dominio propio de correo del tenant (uno por tenant). El dominio se da de
-- alta en la cuenta de Brevo de la plataforma: es único globalmente.
CREATE TABLE "tenant_email_domains" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "from_local_part" TEXT NOT NULL DEFAULT 'no-reply',
  "from_name" TEXT,
  "reply_to" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "dns_records" JSONB NOT NULL DEFAULT '[]',
  "verified_at" TIMESTAMPTZ(6),
  "last_checked_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tenant_email_domains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_email_domains_status_check" CHECK ("status" IN ('pending', 'verified', 'failed')),
  CONSTRAINT "tenant_email_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tenant_email_domains_tenant_id_key" ON "tenant_email_domains"("tenant_id");
CREATE UNIQUE INDEX "tenant_email_domains_domain_key" ON "tenant_email_domains"("domain");

ALTER TABLE "tenant_email_domains" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_email_domains";
CREATE POLICY tenant_isolation ON "tenant_email_domains" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
