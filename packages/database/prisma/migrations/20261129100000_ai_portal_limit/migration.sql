-- Asistente IA: tope diario por inquilino en el chatbot del área de clientes.

-- De qué inquilino es la consulta (chatbot del área de clientes).
ALTER TABLE "ai_usage_events" ADD COLUMN "customer_id" UUID;
CREATE INDEX "ai_usage_events_customer_idx" ON "ai_usage_events" ("tenant_id", "customer_id", "created_at")
  WHERE "customer_id" IS NOT NULL;

-- Preguntas al día por inquilino en el área de clientes.
ALTER TABLE "platform_ai_settings" ADD COLUMN "portal_daily_limit" INTEGER NOT NULL DEFAULT 20;
