-- Reserva antes de la apertura: aviso (al inquilino y al equipo) cuando vence
-- el plazo máximo sin que el local haya abierto. Una sola vez por reserva.
ALTER TABLE "contracts"
  ADD COLUMN "pre_opening_deadline_notified_at" TIMESTAMPTZ(6);
