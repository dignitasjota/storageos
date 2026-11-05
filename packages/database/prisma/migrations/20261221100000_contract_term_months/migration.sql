-- Plazo de cada prórroga automática. Sin él se calculaba desde la fecha de inicio
-- original y cada prórroga duplicaba la anterior (12, 24, 48…).
ALTER TABLE "contracts" ADD COLUMN "term_months" INTEGER;

-- Los contratos ya prorrogados conservan el plazo de su primera prórroga.
UPDATE "contracts" c
SET "term_months" = (
  SELECT (e."payload"->>'months')::int
  FROM "contract_events" e
  WHERE e."contract_id" = c."id" AND e."payload"->>'event' = 'auto_renewed'
  ORDER BY e."occurred_at" ASC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM "contract_events" e
  WHERE e."contract_id" = c."id" AND e."payload"->>'event' = 'auto_renewed'
);
