-- Mejoras del chat con IA de la web y del asistente de WhatsApp.

-- Chat de la web: reservas, paso a una persona y resultados.
ALTER TABLE "web_chat_conversations" ADD COLUMN "contract_id" UUID;
ALTER TABLE "web_chat_conversations" ADD COLUMN "booked_in_chat" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "web_chat_conversations" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE "web_chat_conversations" ADD COLUMN "handoff_requested_at" TIMESTAMPTZ(6);
ALTER TABLE "web_chat_conversations" ADD COLUMN "handoff_summary" TEXT;
ALTER TABLE "web_chat_conversations" ADD COLUMN "staff_unread" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "web_chat_conversations" ADD COLUMN "staff_replied_at" TIMESTAMPTZ(6);
ALTER TABLE "web_chat_conversations"
  ADD CONSTRAINT "web_chat_conversations_contract_id_fkey" FOREIGN KEY ("contract_id")
  REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "web_chat_conversations_tenant_id_mode_idx" ON "web_chat_conversations"("tenant_id", "mode");

ALTER TABLE "web_chat_messages" ADD COLUMN "unanswered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "web_chat_messages" ADD COLUMN "rating" SMALLINT;
ALTER TABLE "web_chat_messages" ADD COLUMN "sender_user_id" UUID;
ALTER TABLE "web_chat_messages"
  ADD CONSTRAINT "web_chat_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id")
  REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tenants" ADD COLUMN "web_chat_bookings_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "web_chat_handoff_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenants" ADD COLUMN "web_chat_shared_instructions" BOOLEAN NOT NULL DEFAULT false;

-- WhatsApp: horario del asistente, intenciones, resumen y seguimiento.
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "assistant_hours_mode" TEXT NOT NULL DEFAULT 'always';
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "team_hours" JSONB;
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "alert_intents" TEXT[] NOT NULL DEFAULT ARRAY['reclamacion', 'baja']::TEXT[];
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "followup_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "followup_template_name" TEXT;
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "followup_template_language" TEXT NOT NULL DEFAULT 'es';

ALTER TABLE "whatsapp_conversations" ADD COLUMN "intent" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN "handoff_summary" TEXT;
ALTER TABLE "whatsapp_conversations" ADD COLUMN "followup_sent_at" TIMESTAMPTZ(6);
