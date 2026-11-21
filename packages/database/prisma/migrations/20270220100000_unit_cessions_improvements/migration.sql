-- Trasteros cedidos: mejoras.
--  * Cesión sin fecha de fin («hasta nuevo aviso»): ends_on admite nulo; no
--    vence nunca y se recuerda al propietario cada review_every_months meses
--    (last_review_notified_at, el último recordatorio).
--  * Con cuántos días de antelación se avisa (notice_days) y «posponer el
--    aviso» de una vencida (snoozed_until).
--  * Motivo con que se terminó (p. ej. «Pasa a contrato»).
--  * Última entrada de la persona: el registro de accesos por credencial.
ALTER TABLE unit_cessions ALTER COLUMN ends_on DROP NOT NULL;

ALTER TABLE unit_cessions
  ADD COLUMN notice_days             INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN snoozed_until           TIMESTAMPTZ(6),
  ADD COLUMN review_every_months     INTEGER,
  ADD COLUMN last_review_notified_at TIMESTAMPTZ(6),
  ADD COLUMN ended_reason            TEXT;

ALTER TABLE unit_cessions
  ADD CONSTRAINT unit_cessions_notice_days_check CHECK (notice_days IN (0, 3, 7, 15, 30)),
  ADD CONSTRAINT unit_cessions_review_every_check
    CHECK (review_every_months IS NULL OR review_every_months IN (1, 3, 6, 12)),
  -- Sin fecha de fin, siempre con cada cuánto recordarla; con fecha, sin ello.
  ADD CONSTRAINT unit_cessions_open_ended_review_check
    CHECK ((ends_on IS NULL) = (review_every_months IS NOT NULL));

-- Recordatorios de las cesiones sin fecha de fin.
CREATE INDEX unit_cessions_live_open_ended_idx ON unit_cessions (starts_on)
  WHERE ended_at IS NULL AND ends_on IS NULL;

-- Última entrada por credencial (cesiones y fichas).
CREATE INDEX access_logs_credential_id_occurred_at_idx
  ON access_logs (credential_id, occurred_at DESC);
