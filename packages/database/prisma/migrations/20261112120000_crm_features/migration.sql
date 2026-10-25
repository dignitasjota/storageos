-- Funcionalidades del CRM: seguimientos y actividad de contactos, contactos sin
-- atender, resultados por campaña, plantillas de campaña, reseña en Google a los
-- testimonios y win-back en dos pasos.

-- Seguimientos (recordatorios con fecha) de un contacto.
CREATE TABLE "lead_followups" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "user_id" UUID,
  "title" TEXT NOT NULL,
  "note" TEXT,
  "due_date" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "lead_followups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_followups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_followups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_followups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "lead_followups_tenant_status_due_idx" ON "lead_followups" ("tenant_id", "status", "due_date");
CREATE INDEX "lead_followups_lead_idx" ON "lead_followups" ("lead_id");

-- Actividad de un contacto (llamadas, visitas, notas).
CREATE TABLE "lead_activities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "user_id" UUID,
  "type" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_activities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_activities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "lead_activities_lead_idx" ON "lead_activities" ("lead_id", "occurred_at");

-- Contactos sin atender y reparto automático.
ALTER TABLE "leads" ADD COLUMN "unattended_notified_at" TIMESTAMPTZ(6);
ALTER TABLE "tenants"
  ADD COLUMN "lead_response_hours" INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN "lead_auto_assign" TEXT NOT NULL DEFAULT 'off';

-- Resultados por campaña: enlaces y clics.
CREATE TABLE "campaign_links" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "campaign_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_links_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "campaign_links_campaign_position_key" ON "campaign_links" ("campaign_id", "position");

CREATE TABLE "campaign_clicks" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "link_id" UUID NOT NULL,
  -- "c:<customerId>" o "l:<leadId>": un clic por destinatario y enlace.
  "recipient_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_clicks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_clicks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_clicks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_clicks_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "campaign_links"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "campaign_clicks_link_recipient_key" ON "campaign_clicks" ("link_id", "recipient_key");
CREATE INDEX "campaign_clicks_campaign_idx" ON "campaign_clicks" ("campaign_id");

-- Plantillas de campaña.
CREATE TABLE "campaign_templates" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body_text" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "campaign_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "campaign_templates_tenant_idx" ON "campaign_templates" ("tenant_id");

-- Testimonios: cuándo se pidió la reseña en Google.
ALTER TABLE "reviews" ADD COLUMN "google_requested_at" TIMESTAMPTZ(6);

-- Win-back en dos pasos.
ALTER TABLE "winback_sends" ADD COLUMN "step" INTEGER NOT NULL DEFAULT 1;
DROP INDEX "winback_sends_tenant_customer_key";
CREATE UNIQUE INDEX "winback_sends_tenant_customer_step_key" ON "winback_sends" ("tenant_id", "customer_id", "step");
ALTER TABLE "tenants"
  ADD COLUMN "winback_second_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "winback_second_delay_days" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "winback_second_subject" TEXT,
  ADD COLUMN "winback_second_body_text" TEXT,
  ADD COLUMN "winback_second_coupon_code" TEXT;

-- RLS de las tablas nuevas.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_followups','lead_activities','campaign_links','campaign_clicks','campaign_templates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO storageos_app USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'', true)::uuid)', t);
  END LOOP;
END $$;
