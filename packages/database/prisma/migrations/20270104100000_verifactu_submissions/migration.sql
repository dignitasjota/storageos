-- Envío de los registros de Veri*Factu en lotes por emisor (2026-11-08).
--
-- Control de flujo (art. 16.2 de la Orden HAC/1177/2024): tras cada envío la
-- AEAT dice cuántos segundos hay que esperar antes del siguiente
-- («TiempoEsperaEnvio», 60 al principio) y en un envío caben hasta 1.000
-- registros de un mismo obligado tributario. Cada emisor (el negocio o cada
-- propietario del plan Administrador) lleva su propia espera.

-- Estado del envío de cada emisor.
CREATE TABLE verifactu_emitters (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id             UUID REFERENCES owners(id) ON DELETE CASCADE,
  -- 'self' (el propio negocio) o el id del propietario.
  emitter_key          TEXT NOT NULL,
  -- Antes de esta hora no sale otro envío (salvo con 1.000 registros).
  next_send_at         TIMESTAMPTZ(6),
  wait_seconds         INTEGER,
  -- Tras un envío fallido, cuándo se vuelve a intentar.
  retry_at             TIMESTAMPTZ(6),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  -- Quien envía lo reserva un rato: dos envíos del mismo emisor nunca van a la vez.
  lease_until          TIMESTAMPTZ(6),
  created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, emitter_key)
);

ALTER TABLE verifactu_emitters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verifactu_emitters FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON verifactu_emitters TO storageos_app;

-- Cada envío a la AEAT, con su resultado y el CSV que lo acredita.
CREATE TABLE verifactu_submissions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id       UUID REFERENCES owners(id) ON DELETE SET NULL,
  emitter_tax_id TEXT NOT NULL,
  -- stub | sandbox | production
  mode           TEXT NOT NULL,
  -- accepted | partially_accepted | rejected | error (sin respuesta válida)
  status         TEXT NOT NULL,
  csv            TEXT,
  wait_seconds   INTEGER,
  record_count   INTEGER NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  message        TEXT,
  sent_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX verifactu_submissions_tenant_sent_idx
  ON verifactu_submissions (tenant_id, sent_at DESC);

ALTER TABLE verifactu_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verifactu_submissions FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON verifactu_submissions TO storageos_app;

-- Los registros por enviar de un emisor, en el orden de su cadena.
CREATE INDEX invoices_verifactu_pending_idx
  ON invoices (tenant_id, owner_id, chain_seq)
  WHERE hash IS NOT NULL AND aeat_status IN ('pending', 'error');
