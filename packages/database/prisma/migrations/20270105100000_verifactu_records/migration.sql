-- Registros de facturación de Veri*Factu por separado (2026-11-08).
--
-- Hasta ahora cada factura guardaba un único registro (huella, cadena, estado)
-- y el XML se rehacía en cada envío con los datos del cliente de ese momento.
-- Una factura puede tener más de un registro: su alta, las altas de
-- subsanación (lo que se corrige tras un rechazo o un aviso de la AEAT) y su
-- anulación (emitida por error). Todos van en la misma cadena del emisor, en el
-- orden en que se generan (art. 7 de la Orden HAC/1177/2024), y cada uno se
-- guarda tal como se generó: no se modifica después.

CREATE TABLE verifactu_records (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id            UUID REFERENCES owners(id) ON DELETE RESTRICT,
  invoice_id          UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  -- alta | anulacion
  kind                TEXT NOT NULL,
  -- Alta de subsanación (Subsanacion=S).
  subsanacion         BOOLEAN NOT NULL DEFAULT false,
  -- RechazoPrevio que se informa: 'S' o 'X' en un alta, 'S' en una anulación.
  rechazo_previo      TEXT,
  -- Anulación de una factura que la AEAT no tiene registrada (SinRegistroPrevio=S).
  sin_registro_previo BOOLEAN NOT NULL DEFAULT false,
  -- Posición en la cadena del emisor (el negocio o cada propietario).
  chain_seq           INTEGER NOT NULL,
  previous_record_id  UUID REFERENCES verifactu_records(id) ON DELETE SET NULL,
  hash                TEXT NOT NULL,
  previous_hash       TEXT,
  -- FechaHoraHusoGenRegistro tal cual entró en la huella.
  record_timestamp    TEXT NOT NULL,
  -- El RegistroFactura tal como se generó. Null en los anteriores a esta
  -- versión: se arman al enviarlos, como hasta ahora.
  xml                 TEXT,
  status              aeat_status NOT NULL DEFAULT 'pending',
  csv                 TEXT,
  response            JSONB,
  sent_at             TIMESTAMPTZ(6),
  submission_id       UUID REFERENCES verifactu_submissions(id) ON DELETE SET NULL,
  -- Se generó o se retrasó por una incidencia técnica: va con Incidencia=S
  -- (art. 16.4 de la Orden).
  incident            BOOLEAN NOT NULL DEFAULT false,
  -- Motivo de la subsanación o de la anulación.
  reason              TEXT,
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- Una posición de la cadena por emisor (Prisma no representa el COALESCE).
CREATE UNIQUE INDEX verifactu_records_chain_unique
  ON verifactu_records (tenant_id, (COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), chain_seq);
CREATE INDEX verifactu_records_invoice_idx ON verifactu_records (invoice_id, chain_seq);
-- Lo que hay que enviar de un emisor, en el orden de su cadena.
CREATE INDEX verifactu_records_pending_idx
  ON verifactu_records (tenant_id, owner_id, chain_seq)
  WHERE status IN ('pending', 'error');

ALTER TABLE verifactu_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verifactu_records FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON verifactu_records TO storageos_app;

-- El registro de alta de cada factura ya registrada, con su estado.
INSERT INTO verifactu_records (
  tenant_id, owner_id, invoice_id, kind, chain_seq, hash, previous_hash,
  record_timestamp, status, csv, response, sent_at, created_at, updated_at
)
SELECT
  i.tenant_id, i.owner_id, i.id, 'alta', i.chain_seq, i.hash, i.previous_hash,
  i.aeat_record_timestamp, COALESCE(i.aeat_status, 'pending'), i.aeat_csv, i.aeat_response,
  i.aeat_sent_at, i.updated_at, i.updated_at
FROM invoices i
WHERE i.chain_seq IS NOT NULL
  AND i.hash IS NOT NULL
  AND i.aeat_record_timestamp IS NOT NULL;

UPDATE verifactu_records r
SET previous_record_id = p.id
FROM invoices i
JOIN verifactu_records p ON p.invoice_id = i.previous_invoice_id
WHERE r.invoice_id = i.id
  AND i.previous_invoice_id IS NOT NULL;

UPDATE verifactu_records r
SET submission_id = s.id
FROM verifactu_submissions s
WHERE r.response ->> 'submissionId' = s.id::text;

-- Lo pendiente ya se busca en los registros.
DROP INDEX IF EXISTS invoices_verifactu_pending_idx;

-- Anular una factura emitida por error (registro de anulación, art. 11 del
-- RRSIF): deja de contar en libros e informes.
ALTER TABLE invoices
  ADD COLUMN voided_at          TIMESTAMPTZ(6),
  ADD COLUMN void_reason        TEXT,
  ADD COLUMN voided_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL;

-- Renuncia a VERI*FACTU (art. 17 de la Orden): el último día en que se usa
-- (siempre un 31 de diciembre). Mientras esté puesta, los envíos la llevan en
-- FechaFinVeriFactu; el 1 de enero se apaga si ha llegado a la AEAT.
ALTER TABLE tenants ADD COLUMN verifactu_end_date DATE;

-- Lo que llevaba cada envío en su cabecera.
ALTER TABLE verifactu_submissions
  ADD COLUMN fecha_fin_verifactu DATE,
  ADD COLUMN incident            BOOLEAN NOT NULL DEFAULT false;
