-- Ciclo de vida de la fianza: importe devuelto + fecha de liquidación + motivo
-- de retención. `deposit_status` (enum existente) ya trazaba held/returned/
-- partially_returned pero nunca se escribía; estos campos completan la
-- liquidación (devolución total/parcial con retención por daños o deuda).
ALTER TABLE "contracts"
  ADD COLUMN "deposit_returned_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "deposit_settled_at" TIMESTAMPTZ(6),
  ADD COLUMN "deposit_retention_reason" TEXT;
