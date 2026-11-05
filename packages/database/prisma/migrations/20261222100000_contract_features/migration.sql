-- Cambio de cuota y traslado programados, y cómo se devolvió la fianza.
ALTER TABLE "contracts"
  ADD COLUMN "scheduled_price" DECIMAL(10,2),
  ADD COLUMN "scheduled_price_date" DATE,
  ADD COLUMN "scheduled_price_reason" TEXT,
  ADD COLUMN "scheduled_unit_id" UUID,
  ADD COLUMN "scheduled_unit_date" DATE,
  ADD COLUMN "scheduled_unit_price" DECIMAL(10,2),
  ADD COLUMN "scheduled_unit_prorate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deposit_applied_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "deposit_return_method" TEXT,
  ADD COLUMN "deposit_returned_on" DATE,
  ADD COLUMN "deposit_return_reference" TEXT;

ALTER TABLE "contracts"
  ADD CONSTRAINT "contracts_scheduled_unit_id_fkey"
  FOREIGN KEY ("scheduled_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "contracts_scheduled_price_date_idx" ON "contracts"("scheduled_price_date")
  WHERE "scheduled_price_date" IS NOT NULL;
CREATE INDEX "contracts_scheduled_unit_date_idx" ON "contracts"("scheduled_unit_date")
  WHERE "scheduled_unit_date" IS NOT NULL;

-- Lista de espera: el trastero se guarda 48 h para quien recibe el aviso, con un
-- enlace propio para reservarlo.
ALTER TABLE "waitlist_entries"
  ADD COLUMN "held_unit_id" UUID,
  ADD COLUMN "hold_token_hash" TEXT,
  ADD COLUMN "converted_contract_id" UUID;

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_held_unit_id_fkey"
  FOREIGN KEY ("held_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "waitlist_entries_converted_contract_id_fkey"
  FOREIGN KEY ("converted_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "waitlist_entries_hold_token_hash_key" ON "waitlist_entries"("hold_token_hash");
