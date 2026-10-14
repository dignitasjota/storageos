-- Extra «WhatsApp Business»: el tenant conecta su número de WhatsApp (Cloud
-- API de Meta), recibe en el panel los mensajes de quien le escribe desde su
-- web (o por cualquier vía) y responde desde ahí.

-- Número conectado (uno por tenant). Los mensajes entrantes se asignan al
-- tenant por el `phone_number_id` del número de destino → único global.
CREATE TABLE "tenant_whatsapp_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "phone_number_id" TEXT NOT NULL,
  "waba_id" TEXT,
  "display_phone" TEXT,
  "verified_name" TEXT,
  "access_token_encrypted" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "web_button_enabled" BOOLEAN NOT NULL DEFAULT true,
  "last_checked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_whatsapp_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_whatsapp_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "tenant_whatsapp_settings_tenant_key" ON "tenant_whatsapp_settings" ("tenant_id");
CREATE UNIQUE INDEX "tenant_whatsapp_settings_phone_key" ON "tenant_whatsapp_settings" ("phone_number_id");

-- Una conversación por contacto (número de WhatsApp) y tenant.
CREATE TABLE "whatsapp_conversations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "wa_id" TEXT NOT NULL,
  "contact_name" TEXT,
  "customer_id" UUID,
  "lead_id" UUID,
  "last_inbound_at" TIMESTAMPTZ(6),
  "last_message_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_message_preview" TEXT,
  "unread_count" INTEGER NOT NULL DEFAULT 0,
  "assistant_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "whatsapp_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "whatsapp_conversations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "whatsapp_conversations_contact_key" ON "whatsapp_conversations" ("tenant_id", "wa_id");
CREATE INDEX "whatsapp_conversations_recent_idx" ON "whatsapp_conversations" ("tenant_id", "last_message_at" DESC);

CREATE TABLE "whatsapp_messages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  -- in = del contacto; out = del negocio.
  "direction" TEXT NOT NULL,
  -- contact | staff | assistant
  "sender" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  -- Id de Meta (wamid…): deduplica reentregas y casa los avisos de estado.
  "wa_message_id" TEXT,
  -- received | sent | delivered | read | failed
  "status" TEXT NOT NULL,
  "error" TEXT,
  "sent_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "whatsapp_conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_messages_sent_by_user_id_fkey" FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "whatsapp_messages_wa_id_key" ON "whatsapp_messages" ("wa_message_id");
CREATE INDEX "whatsapp_messages_conversation_idx" ON "whatsapp_messages" ("conversation_id", "created_at");

ALTER TABLE "tenant_whatsapp_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_whatsapp_settings" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "whatsapp_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_conversations" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "whatsapp_messages" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
