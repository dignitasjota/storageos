-- Desistimiento de los contratos a distancia (art. 102 y ss. TRLGDCU): plazo,
-- petición expresa de empezar antes de que acabe y fecha del desistimiento.
ALTER TABLE "contracts"
  ADD COLUMN "withdrawal_deadline" DATE,
  ADD COLUMN "immediate_start_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "withdrawn_at" TIMESTAMPTZ(6);
