-- Trasteros cedidos: a quién se presta el trastero, hasta cuándo, su acceso y
-- el estado del que venía. El historial (cesiones terminadas) se conserva.
CREATE TABLE unit_cessions (
  id                    UUID NOT NULL DEFAULT uuid_generate_v7(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  unit_id               UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  holder_name           TEXT,
  holder_phone          TEXT,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  starts_on             DATE NOT NULL,
  ends_on               DATE NOT NULL,
  notes                 TEXT,
  access_credential_id  UUID REFERENCES access_credentials(id) ON DELETE SET NULL,
  previous_unit_status  "unit_status" NOT NULL,
  created_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  ended_at              TIMESTAMPTZ(6),
  ended_by_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  ended_unit_status     "unit_status",
  expiring_notified_at  TIMESTAMPTZ(6),
  expired_notified_at   TIMESTAMPTZ(6),
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT unit_cessions_pkey PRIMARY KEY (id),
  CONSTRAINT unit_cessions_dates_check CHECK (ends_on >= starts_on),
  CONSTRAINT unit_cessions_holder_check CHECK (holder_name IS NOT NULL OR customer_id IS NOT NULL)
);

-- Una sola cesión viva por trastero.
CREATE UNIQUE INDEX unit_cessions_live_unit_key ON unit_cessions (unit_id) WHERE ended_at IS NULL;
CREATE INDEX unit_cessions_tenant_idx ON unit_cessions (tenant_id);
CREATE INDEX unit_cessions_unit_idx ON unit_cessions (unit_id, created_at DESC);
CREATE INDEX unit_cessions_customer_idx ON unit_cessions (tenant_id, customer_id);
-- Para los avisos y «Hoy»: cesiones vivas por fecha de fin.
CREATE INDEX unit_cessions_live_ends_idx ON unit_cessions (ends_on) WHERE ended_at IS NULL;

ALTER TABLE unit_cessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unit_cessions FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON unit_cessions TO storageos_app;
