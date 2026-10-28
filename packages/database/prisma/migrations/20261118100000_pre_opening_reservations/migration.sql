-- Reserva anticipada de trasteros en locales que aún no han abierto.

-- Local en «próxima apertura»: la fecha es opcional (puede no estar clara) y
-- se puede poner, cambiar o quitar. `pre_opening_max_months`: plazo desde la
-- firma tras el cual, si el local no ha abierto, el inquilino puede cancelar y
-- recuperar todo lo pagado.
ALTER TABLE "facilities"
  ADD COLUMN "pre_opening" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "opening_date" DATE,
  ADD COLUMN "pre_opening_max_months" INTEGER NOT NULL DEFAULT 6;

-- Contrato de reserva anticipada. `start_date` es la fecha de apertura cuando
-- se conoce y, mientras no la hay, la fecha límite (provisional); la
-- recurrente no factura hasta `pre_opening_started_at` (día de apertura).
ALTER TABLE "contracts"
  ADD COLUMN "pre_opening" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pre_opening_date_confirmed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pre_opening_deadline" DATE,
  ADD COLUMN "pre_opening_started_at" TIMESTAMPTZ(6),
  ADD COLUMN "pre_opening_reminder_sent_at" TIMESTAMPTZ(6);

CREATE INDEX "contracts_pre_opening_pending_idx"
  ON "contracts" ("tenant_id", "unit_id")
  WHERE "pre_opening" = true AND "pre_opening_started_at" IS NULL;
