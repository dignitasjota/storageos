-- WhatsApp Business (PR 3): reservas preparadas por el asistente y
-- recordatorios por plantilla aprobada.
ALTER TABLE "tenant_whatsapp_settings"
  ADD COLUMN "assistant_bookings_enabled" BOOLEAN NOT NULL DEFAULT true,
  -- Plantilla aprobada en Meta para el recordatorio de reserva sin terminar:
  -- cuerpo con {{1}} = nombre y {{2}} = enlace.
  ADD COLUMN "reminder_template_name" TEXT,
  ADD COLUMN "reminder_template_language" TEXT NOT NULL DEFAULT 'es';

ALTER TABLE "whatsapp_conversations"
  ADD COLUMN "contract_id" UUID,
  ADD COLUMN "booking_reminder_sent_at" TIMESTAMPTZ(6),
  ADD CONSTRAINT "whatsapp_conversations_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL;
CREATE INDEX "whatsapp_conversations_booking_idx" ON "whatsapp_conversations" ("contract_id")
  WHERE "contract_id" IS NOT NULL AND "booking_reminder_sent_at" IS NULL;
