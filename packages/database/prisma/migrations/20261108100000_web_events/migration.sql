-- Analítica propia de la web del tenant: páginas vistas y clics de contacto
-- (llamar, WhatsApp, email, cómo llegar). Sin IP ni datos personales: un
-- identificador aleatorio del navegador y el origen de la visita.
CREATE TABLE "web_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "visitor_id" TEXT NOT NULL,
  -- page_view | call_click | whatsapp_click | email_click | directions_click
  "kind" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "source" TEXT,
  "medium" TEXT,
  "campaign" TEXT,
  -- mobile | tablet | desktop
  "device" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "web_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "web_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "web_events_tenant_created_idx" ON "web_events" ("tenant_id", "created_at");
CREATE INDEX "web_events_visitor_idx" ON "web_events" ("tenant_id", "visitor_id", "created_at");

ALTER TABLE "web_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_events" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
