-- Acciones que el asistente IA PROPONE (crear tarea, recordatorio de pago,
-- mensaje al inquilino) y que el usuario confirma o descarta desde la UI.
-- El modelo nunca ejecuta nada por su cuenta.
CREATE TABLE "ai_pending_actions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "message_id" UUID,
  "user_id" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "result" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "ai_pending_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_pending_actions_conversation_id_idx" ON "ai_pending_actions"("conversation_id");
CREATE INDEX "ai_pending_actions_tenant_id_user_id_idx" ON "ai_pending_actions"("tenant_id", "user_id");

ALTER TABLE "ai_pending_actions"
  ADD CONSTRAINT "ai_pending_actions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_pending_actions"
  ADD CONSTRAINT "ai_pending_actions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_pending_actions"
  ADD CONSTRAINT "ai_pending_actions_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_pending_actions"
  ADD CONSTRAINT "ai_pending_actions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_pending_actions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ai_pending_actions";
CREATE POLICY tenant_isolation ON "ai_pending_actions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
