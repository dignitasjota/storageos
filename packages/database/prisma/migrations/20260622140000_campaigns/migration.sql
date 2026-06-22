-- Crecimiento/CRM: campañas segmentadas por email.
--
-- Segmenta clientes/leads por criterios y envía un email masivo vía el outbox
-- de communications (una `communications` por destinatario, source=campaign:<id>).

CREATE TABLE "campaigns" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'email',
  "subject" TEXT NOT NULL,
  "body_text" TEXT NOT NULL,
  "segment" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "audience_count" INTEGER NOT NULL DEFAULT 0,
  "sent_count" INTEGER NOT NULL DEFAULT 0,
  "scheduled_for" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaigns_tenant_id_status_idx" ON "campaigns"("tenant_id", "status");
CREATE INDEX "campaigns_tenant_id_created_at_idx" ON "campaigns"("tenant_id", "created_at");

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "campaigns";
CREATE POLICY tenant_isolation ON "campaigns"
    FOR ALL TO storageos_app
    USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
