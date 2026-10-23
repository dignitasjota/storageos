-- Revisión de los mandatos SEPA.
--
-- 1) Cada mandato guarda el preaviso pactado al firmarlo: la remesa respeta
--    el plazo de cada deudor aunque luego cambie el ajuste del acreedor.
-- 2) A quién se envió el enlace de firma (constancia ante una reclamación).
-- 3) Estado del preaviso de cada adeudo de la plataforma (enviado/fallido).

ALTER TABLE sepa_mandates
  ADD COLUMN prenotice_days INTEGER,
  ADD COLUMN signing_link_sent_to TEXT;

ALTER TABLE platform_sepa_mandates
  ADD COLUMN prenotice_days INTEGER;

ALTER TABLE platform_sepa_remittance_items
  ADD COLUMN prenotice_status TEXT;

-- Firmados en la app: el plazo que dice el texto firmado.
UPDATE sepa_mandates
SET prenotice_days = (substring(document_text FROM 'Plazo de preaviso de cada adeudo: (\d+) d'))::int
WHERE document_text IS NOT NULL;

UPDATE platform_sepa_mandates
SET prenotice_days = (substring(document_text FROM 'Plazo de preaviso de cada adeudo: (\d+) d'))::int
WHERE document_text IS NOT NULL;

-- El resto (papel, migrados o pendientes): el ajuste vigente del acreedor.
UPDATE sepa_mandates m
SET prenotice_days = s.prenotice_days
FROM sepa_settings s
WHERE s.tenant_id = m.tenant_id AND m.prenotice_days IS NULL;

UPDATE platform_sepa_mandates
SET prenotice_days = (SELECT prenotice_days FROM platform_sepa_settings LIMIT 1)
WHERE prenotice_days IS NULL;

-- Preavisos ya enviados.
UPDATE platform_sepa_remittance_items
SET prenotice_status = 'sent'
WHERE prenotice_sent_at IS NOT NULL;
