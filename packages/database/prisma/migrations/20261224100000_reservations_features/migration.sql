-- Reservas, lista de espera y peticiones de trastero: mejoras.

-- Ajustes del negocio.
ALTER TABLE tenants
  ADD COLUMN waitlist_hold_hours INTEGER NOT NULL DEFAULT 48,
  ADD COLUMN waitlist_stale_days INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN reservation_signal_policy TEXT NOT NULL DEFAULT 'refund';

-- Reservas: recordatorio antes de caducar y responsable.
ALTER TABLE reservations
  ADD COLUMN reminder_sent_at TIMESTAMPTZ(6),
  ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Lista de espera: orden de la cola, plazo del aviso, trastero preasignado,
-- confirmación de que sigue interesado y responsable.
ALTER TABLE waitlist_entries
  ADD COLUMN queue_date TIMESTAMPTZ(6),
  ADD COLUMN hold_expires_at TIMESTAMPTZ(6),
  ADD COLUMN no_reply_alerted_at TIMESTAMPTZ(6),
  ADD COLUMN preassigned_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  ADD COLUMN interest_asked_at TIMESTAMPTZ(6),
  ADD COLUMN interest_confirmed_at TIMESTAMPTZ(6),
  ADD COLUMN interest_token_hash TEXT,
  ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE waitlist_entries SET queue_date = created_at;
ALTER TABLE waitlist_entries
  ALTER COLUMN queue_date SET NOT NULL,
  ALTER COLUMN queue_date SET DEFAULT now();

-- Los avisos en vigor conservan sus 48 horas.
UPDATE waitlist_entries
  SET hold_expires_at = notified_at + INTERVAL '48 hours'
  WHERE status = 'notified' AND notified_at IS NOT NULL;

CREATE UNIQUE INDEX waitlist_entries_interest_token_hash_key
  ON waitlist_entries (interest_token_hash);
CREATE INDEX waitlist_entries_preassigned_unit_id_idx
  ON waitlist_entries (preassigned_unit_id);

-- Peticiones de trastero: responsable.
ALTER TABLE unit_change_requests
  ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE unit_requests
  ADD COLUMN assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
