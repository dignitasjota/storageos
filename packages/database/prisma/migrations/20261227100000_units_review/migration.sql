-- Revisión de Trasteros: quién ha tenido cada trastero y pares apilados rotos.

-- Cada tramo de un contrato en un trastero. Un traslado cierra un tramo y abre
-- otro: el contrato solo apunta al trastero actual y el trastero de origen se
-- quedaba sin historial.
CREATE TABLE unit_tenancies (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  unit_id       UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  contract_id   UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  started_on    DATE NOT NULL,
  ended_on      DATE,
  price_monthly DECIMAL(10, 2) NOT NULL,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX unit_tenancies_tenant_idx ON unit_tenancies (tenant_id);
CREATE INDEX unit_tenancies_unit_idx ON unit_tenancies (unit_id, started_on DESC);
CREATE INDEX unit_tenancies_contract_idx ON unit_tenancies (contract_id);
CREATE UNIQUE INDEX unit_tenancies_one_open ON unit_tenancies (contract_id) WHERE ended_on IS NULL;

ALTER TABLE unit_tenancies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON unit_tenancies FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON unit_tenancies TO storageos_app;

-- La mantiene un disparador: hay muchos caminos que firman, trasladan y terminan
-- un contrato (panel, reserva online, área de clientes, apertura de un local,
-- procesos programados) y así ninguno se olvida.
CREATE OR REPLACE FUNCTION contracts_sync_unit_tenancy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  today DATE := (now() AT TIME ZONE 'Europe/Madrid')::date;
  running BOOLEAN := NEW.status IN ('active', 'ending')
    AND NEW.signed_at IS NOT NULL
    AND NEW.deleted_at IS NULL
    AND NOT (NEW.pre_opening AND NEW.pre_opening_started_at IS NULL);
  current_row unit_tenancies%ROWTYPE;
BEGIN
  SELECT * INTO current_row FROM unit_tenancies
  WHERE contract_id = NEW.id AND ended_on IS NULL;

  IF NOT running THEN
    IF FOUND THEN
      UPDATE unit_tenancies
      SET ended_on = GREATEST(
        started_on,
        (COALESCE(NEW.ended_at, NEW.cancelled_at, now()) AT TIME ZONE 'Europe/Madrid')::date
      )
      WHERE id = current_row.id;
    END IF;
    RETURN NEW;
  END IF;

  IF NOT FOUND THEN
    INSERT INTO unit_tenancies (tenant_id, unit_id, contract_id, started_on, price_monthly)
    VALUES (
      NEW.tenant_id,
      NEW.unit_id,
      NEW.id,
      CASE
        WHEN EXISTS (SELECT 1 FROM unit_tenancies t WHERE t.contract_id = NEW.id) THEN today
        ELSE NEW.start_date
      END,
      NEW.price_monthly
    );
  ELSIF current_row.unit_id <> NEW.unit_id THEN
    UPDATE unit_tenancies SET ended_on = GREATEST(started_on, today) WHERE id = current_row.id;
    INSERT INTO unit_tenancies (tenant_id, unit_id, contract_id, started_on, price_monthly)
    VALUES (
      NEW.tenant_id,
      NEW.unit_id,
      NEW.id,
      GREATEST(current_row.started_on, today),
      NEW.price_monthly
    );
  ELSIF current_row.price_monthly <> NEW.price_monthly THEN
    UPDATE unit_tenancies SET price_monthly = NEW.price_monthly WHERE id = current_row.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contracts_unit_tenancy
  AFTER INSERT OR UPDATE OF status, unit_id, signed_at, deleted_at, pre_opening_started_at, price_monthly
  ON contracts
  FOR EACH ROW EXECUTE FUNCTION contracts_sync_unit_tenancy();

-- Relleno de lo que ya existe: los traslados salen de los eventos del contrato.
WITH moves AS (
  SELECT
    e.contract_id,
    (e.payload->>'fromUnitId')::uuid AS from_unit,
    (e.occurred_at AT TIME ZONE 'Europe/Madrid')::date AS moved_on,
    row_number() OVER w AS n,
    lag((e.occurred_at AT TIME ZONE 'Europe/Madrid')::date) OVER w AS previous_move
  FROM contract_events e
  WHERE e.event_type = 'unit_changed' AND e.payload ? 'fromUnitId'
  WINDOW w AS (PARTITION BY e.contract_id ORDER BY e.occurred_at)
),
signed AS (
  SELECT c.*
  FROM contracts c
  WHERE c.signed_at IS NOT NULL
    AND c.deleted_at IS NULL
    AND c.status IN ('active', 'ending', 'ended', 'cancelled')
    AND NOT (c.pre_opening AND c.pre_opening_started_at IS NULL)
)
INSERT INTO unit_tenancies (tenant_id, unit_id, contract_id, started_on, ended_on, price_monthly)
SELECT
  s.tenant_id,
  m.from_unit,
  s.id,
  COALESCE(m.previous_move, s.start_date),
  GREATEST(m.moved_on, COALESCE(m.previous_move, s.start_date)),
  s.price_monthly
FROM moves m
JOIN signed s ON s.id = m.contract_id
JOIN units u ON u.id = m.from_unit
UNION ALL
SELECT
  s.tenant_id,
  s.unit_id,
  s.id,
  COALESCE(last_move.moved_on, s.start_date),
  CASE WHEN s.status IN ('ended', 'cancelled') THEN GREATEST(
    COALESCE(last_move.moved_on, s.start_date),
    (COALESCE(s.ended_at, s.cancelled_at, s.updated_at) AT TIME ZONE 'Europe/Madrid')::date
  ) END,
  s.price_monthly
FROM signed s
LEFT JOIN LATERAL (
  SELECT m.moved_on FROM moves m WHERE m.contract_id = s.id ORDER BY m.n DESC LIMIT 1
) last_move ON true;

-- Pareja borrada: la taquilla que queda vuelve a ser un trastero normal (la de
-- arriba no se dibujaba en el plano y no había forma de desapilarla).
UPDATE units u
SET stack_group_id = NULL, stack_level = NULL
WHERE u.stack_group_id IS NOT NULL
  AND (SELECT count(*) FROM units p WHERE p.stack_group_id = u.stack_group_id) < 2;

-- Pareja separada en dos plantas: se desapila y la de arriba, que llevaba la
-- posición del plano de otra planta, se recoloca sola.
WITH split AS (
  SELECT stack_group_id
  FROM units
  WHERE stack_group_id IS NOT NULL
  GROUP BY stack_group_id
  HAVING count(DISTINCT floor_id) > 1
)
UPDATE units u
SET
  stack_group_id = NULL,
  stack_level = NULL,
  plan_x = CASE WHEN u.stack_level = 1 THEN NULL ELSE u.plan_x END,
  plan_y = CASE WHEN u.stack_level = 1 THEN NULL ELSE u.plan_y END,
  plan_width = CASE WHEN u.stack_level = 1 THEN NULL ELSE u.plan_width END,
  plan_height = CASE WHEN u.stack_level = 1 THEN NULL ELSE u.plan_height END
FROM split
WHERE u.stack_group_id = split.stack_group_id;
