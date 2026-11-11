-- Cada contrato conserva las reglas con las que se firmó: la baja a final de
-- mes y el abono de lo prepagado sin descuento solo valen para los contratos
-- que se firmen desde ahora (los anteriores, como estaban).
ALTER TABLE "contracts"
  ADD COLUMN "move_out_end_of_month" BOOLEAN,
  ADD COLUMN "prepaid_credit_at_list_price" BOOLEAN NOT NULL DEFAULT false;
