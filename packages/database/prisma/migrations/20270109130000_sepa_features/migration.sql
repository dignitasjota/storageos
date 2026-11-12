-- Remesas SEPA de los inquilinos (revisión de Cobros, PR B).

-- Remesa automática mensual: el día elegido se prepara sola, sin confirmar.
ALTER TABLE sepa_settings
  ADD COLUMN auto_prepare BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN auto_prepare_day INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN last_auto_prepared_month TEXT;

-- La remesa preparada sola, el aviso de las que siguen sin confirmar y la
-- respuesta del banco (pain.002) ya cargada.
ALTER TABLE sepa_remittances
  ADD COLUMN auto_prepared BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN stale_notified_at TIMESTAMPTZ(6),
  ADD COLUMN bank_response_at TIMESTAMPTZ(6);

-- Aviso de que el mandato caduca (36 meses sin cobros): la fecha avisada.
ALTER TABLE sepa_mandates ADD COLUMN expiry_notified_for DATE;
