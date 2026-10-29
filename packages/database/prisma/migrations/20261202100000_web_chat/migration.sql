-- Chat con IA en la web pública del tenant (visitantes anónimos).

-- Activado por defecto con el asistente IA; el tenant lo puede apagar.
ALTER TABLE "tenants" ADD COLUMN "web_chat_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "web_chat_instructions" TEXT;
-- Límite de respuestas al mes de la web (null = el general de la plataforma).
ALTER TABLE "tenants" ADD COLUMN "web_chat_monthly_limit" INTEGER;
ALTER TABLE "tenants" ADD COLUMN "web_chat_limit_notified" TEXT;

-- Límites y modelo del chat de la web (aparte de los del panel).
ALTER TABLE "platform_ai_settings" ADD COLUMN "web_monthly_limit" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "platform_ai_settings" ADD COLUMN "web_visitor_daily_limit" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "platform_ai_settings" ADD COLUMN "web_model" TEXT;

-- Una conversación por visitante (id aleatorio del navegador, sin datos personales).
CREATE TABLE "web_chat_conversations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "visitor_id" TEXT NOT NULL,
  "locale" TEXT NOT NULL DEFAULT 'es',
  "page_path" TEXT,
  "lead_id" UUID,
  "message_count" INTEGER NOT NULL DEFAULT 0,
  "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "web_chat_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "web_chat_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "web_chat_conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "web_chat_conversations_tenant_id_visitor_id_key" ON "web_chat_conversations"("tenant_id", "visitor_id");
CREATE INDEX "web_chat_conversations_tenant_id_last_message_at_idx" ON "web_chat_conversations"("tenant_id", "last_message_at");

CREATE TABLE "web_chat_messages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  -- visitor | assistant
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "web_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "web_chat_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "web_chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "web_chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "web_chat_messages_conversation_id_created_at_idx" ON "web_chat_messages"("conversation_id", "created_at");
CREATE INDEX "web_chat_messages_tenant_id_created_at_idx" ON "web_chat_messages"("tenant_id", "created_at");

ALTER TABLE "web_chat_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_chat_conversations" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "web_chat_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_chat_messages" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "web_chat_conversations" TO storageos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "web_chat_messages" TO storageos_app;
