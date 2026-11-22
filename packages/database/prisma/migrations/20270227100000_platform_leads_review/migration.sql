-- Revisión de los leads del panel admin.
-- Desde cuándo espera respuesta un lead: un perdido que vuelve a escribir empieza
-- un ciclo nuevo (el aviso de «sin atender» y «Hoy» cuentan desde su mensaje)
-- sin perder la primera respuesta histórica (first_response_at).
ALTER TABLE platform_leads ADD COLUMN awaiting_reply_since TIMESTAMPTZ(6);

UPDATE platform_leads
   SET awaiting_reply_since = created_at
 WHERE status = 'new' AND first_response_at IS NULL AND discarded_at IS NULL;
