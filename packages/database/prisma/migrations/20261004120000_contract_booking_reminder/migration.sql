-- Reserva online enviada pero sin terminar (sin firmar o sin pagar): el
-- trastero queda retenido 72 h y se libera solo. Se recuerda una vez al
-- inquilino antes de que caduque; esta marca evita repetirlo.
ALTER TABLE "contracts" ADD COLUMN "booking_reminder_sent_at" TIMESTAMPTZ(6);
