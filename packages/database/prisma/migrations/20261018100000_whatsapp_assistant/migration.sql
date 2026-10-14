-- Asistente de IA del WhatsApp Business de los tenants (PR 2). La IA de
-- WhatsApp es independiente de la del asistente del panel.

-- IA de WhatsApp de la plataforma (un registro). Global → REVOKE.
CREATE TABLE "platform_whatsapp_ai_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  -- anthropic | openai | minimax | openai_compatible
  "provider" TEXT NOT NULL DEFAULT 'anthropic',
  "model" TEXT NOT NULL DEFAULT '',
  "base_url" TEXT,
  "api_key_encrypted" TEXT,
  -- Respuestas del asistente al mes por tenant con la IA de la plataforma.
  "monthly_reply_limit" INTEGER NOT NULL DEFAULT 300,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_whatsapp_ai_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_whatsapp_ai_settings" FROM storageos_app;

-- Por tenant: qué IA usa (la decide el super admin), su clave propia y el
-- asistente (lo activa el tenant).
ALTER TABLE "tenant_whatsapp_settings"
  ADD COLUMN "assistant_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "assistant_instructions" TEXT,
  -- platform | own
  ADD COLUMN "ai_mode" TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN "ai_monthly_limit" INTEGER,
  ADD COLUMN "own_ai_provider" TEXT,
  ADD COLUMN "own_ai_model" TEXT,
  ADD COLUMN "own_ai_base_url" TEXT,
  ADD COLUMN "own_ai_api_key_encrypted" TEXT,
  -- Último mes (AAAA-MM) en que se avisó de que se llegó al límite.
  ADD COLUMN "ai_limit_notified_month" TEXT;

-- Qué clave usó cada respuesta del asistente (cuenta para el límite la de la plataforma).
ALTER TABLE "whatsapp_messages" ADD COLUMN "ai_key_source" TEXT;
CREATE INDEX "whatsapp_messages_assistant_idx" ON "whatsapp_messages" ("tenant_id", "created_at")
  WHERE "sender" = 'assistant' AND "ai_key_source" = 'platform';
