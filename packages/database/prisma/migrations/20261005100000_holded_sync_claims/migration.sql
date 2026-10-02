-- Copia en Holded sin duplicados. Antes se comprobaba si ya había copia, se
-- creaba en Holded y se guardaba el id, sin bloqueo: dos envíos a la vez (aviso
-- al emitir + «Enviar pendientes», «emitida» + «pagada») o una caída justo
-- después de crearla duplicaban la factura o el cobro en Holded.
--
-- Ahora cada copia se reserva antes de llamar a Holded:
--   invoices.holded_sync_state: NULL = nada en curso | 'creating' = reservada,
--     llamando a Holded | 'approving' = creada (id guardado), falta aprobarla.
--   *.holded_sync_started_at: cuándo se reservó. Si Holded no responde (red,
--     tiempo agotado) la reserva se queda: no se reintenta sola (podría haberse
--     creado) y sale «para revisar» en Ajustes → Facturación.
--   payments.holded_reviewed_at: un cobro ya copiado que luego se devolvió o
--     reembolsó sale «para revisar» hasta que alguien lo marca como revisado.
ALTER TABLE "invoices"
  ADD COLUMN "holded_sync_state" TEXT,
  ADD COLUMN "holded_sync_started_at" TIMESTAMPTZ(6);

ALTER TABLE "payments"
  ADD COLUMN "holded_sync_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "holded_reviewed_at" TIMESTAMPTZ(6);
