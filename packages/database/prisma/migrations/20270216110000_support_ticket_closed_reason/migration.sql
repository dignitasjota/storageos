-- Por qué se cerró un ticket: lo cerró el negocio (`tenant`), el soporte
-- (`admin`) o se cerró solo por falta de respuesta (`inactivity`). Null en los
-- abiertos y en los cerrados antes de existir esta columna.
ALTER TABLE support_tickets ADD COLUMN closed_reason TEXT;

ALTER TABLE support_tickets
  ADD CONSTRAINT support_tickets_closed_reason_check
  CHECK (closed_reason IS NULL OR closed_reason IN ('tenant', 'admin', 'inactivity'));
