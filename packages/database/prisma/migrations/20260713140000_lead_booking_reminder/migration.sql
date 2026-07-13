-- Recuperación de reservas abandonadas: marca cuándo se envió el recordatorio de
-- nurture a un lead de booking abandonado (email-first sin convertir), para que
-- el cron sea idempotente y no reenvíe.
ALTER TABLE "leads" ADD COLUMN "booking_reminder_sent_at" TIMESTAMPTZ;
