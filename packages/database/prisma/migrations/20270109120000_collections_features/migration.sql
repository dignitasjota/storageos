-- Impagos: plan de pagos ligado al expediente, retirar el candado, sobrante
-- devuelto, avisos, cita de retirada desde el área de clientes y días del
-- escalado editables (2026-11-11).

ALTER TABLE delinquency_cases
  -- En pausa mientras el inquilino cumple un plan de pagos.
  ADD COLUMN paused_at TIMESTAMPTZ(6),
  ADD COLUMN payment_plan_id UUID REFERENCES payment_plans(id) ON DELETE SET NULL,
  ADD COLUMN overlock_removed_at TIMESTAMPTZ(6),
  -- Lo que sobró al liquidar con la disposición, y cuándo se le devolvió.
  ADD COLUMN surplus_cents INTEGER,
  ADD COLUMN surplus_returned_at TIMESTAMPTZ(6),
  -- Avisos ya enviados al equipo (clave → día), para no repetirlos.
  ADD COLUMN alerts_sent JSONB NOT NULL DEFAULT '{}';

-- El inquilino pide una cita para retirar sus bienes; el equipo la concede con
-- una franja y un código de un solo uso.
CREATE TABLE delinquency_pickup_requests (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id             UUID NOT NULL REFERENCES delinquency_cases(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  preferred_date      DATE NOT NULL,
  -- morning | afternoon | any
  preferred_time      TEXT NOT NULL DEFAULT 'any',
  note                TEXT,
  -- pending | approved | rejected | done | cancelled
  status              TEXT NOT NULL DEFAULT 'pending',
  approved_from       TIMESTAMPTZ(6),
  approved_until      TIMESTAMPTZ(6),
  credential_id       UUID REFERENCES access_credentials(id) ON DELETE SET NULL,
  resolution_note     TEXT,
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMPTZ(6),
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX delinquency_pickup_requests_case_idx ON delinquency_pickup_requests (case_id);
-- Una sola petición pendiente por expediente.
CREATE UNIQUE INDEX delinquency_pickup_requests_one_pending
  ON delinquency_pickup_requests (case_id) WHERE status = 'pending';

ALTER TABLE delinquency_pickup_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delinquency_pickup_requests FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON delinquency_pickup_requests TO storageos_app;

-- Días de los dos recordatorios del escalado (antes, siempre 1 y 7).
ALTER TABLE tenants
  ADD COLUMN dunning_first_reminder_days INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN dunning_second_reminder_days INTEGER NOT NULL DEFAULT 7;
