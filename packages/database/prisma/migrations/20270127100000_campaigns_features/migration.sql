-- Mejoras de Campañas y Comunicaciones.

-- Versión en inglés, cupón ofrecido y plantilla de WhatsApp de una campaña.
ALTER TABLE "campaigns" ADD COLUMN "subject_en" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "body_text_en" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "coupon_code" TEXT;
ALTER TABLE "campaigns" ADD COLUMN "whatsapp_template" JSONB;

-- Segmentos guardados (a quién va una campaña).
CREATE TABLE "campaign_segments" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "segment" JSONB NOT NULL,
  "created_by_user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "campaign_segments_tenant_idx" ON "campaign_segments" ("tenant_id", "name");
ALTER TABLE "campaign_segments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "campaign_segments";
CREATE POLICY tenant_isolation ON "campaign_segments" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Campañas automáticas (aniversario del contrato, contactos que no avanzan).
CREATE TABLE "campaign_automations" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- anniversary | cold_leads
  "kind" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "subject" TEXT,
  "body_text" TEXT,
  "days" INTEGER NOT NULL DEFAULT 30,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "campaign_automations_tenant_kind_key" ON "campaign_automations" ("tenant_id", "kind");
ALTER TABLE "campaign_automations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "campaign_automations";
CREATE POLICY tenant_isolation ON "campaign_automations" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Envíos de las campañas automáticas: uno por destinatario y periodo (el año
-- del aniversario; `once` para los contactos). `recipient_key` = `c:<id>` o
-- `l:<id>` (sin clave ajena: no hay que moverla al fusionar fichas).
CREATE TABLE "campaign_automation_sends" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "recipient_key" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "sent_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "campaign_automation_sends_unique"
  ON "campaign_automation_sends" ("tenant_id", "kind", "recipient_key", "period");
CREATE INDEX "campaign_automation_sends_recent_idx"
  ON "campaign_automation_sends" ("tenant_id", "kind", "sent_at");
ALTER TABLE "campaign_automation_sends" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "campaign_automation_sends";
CREATE POLICY tenant_isolation ON "campaign_automation_sends" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
