-- Promoción aplicada al contrato + contador de meses gratis pendientes
-- (promociones `free_months`). La facturación recurrente emite las primeras N
-- facturas con el alquiler a 0 y decrementa `free_months_remaining`.
ALTER TABLE "contracts" ADD COLUMN "promotion_id" UUID;
ALTER TABLE "contracts" ADD COLUMN "free_months_remaining" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "contracts"
  ADD CONSTRAINT "contracts_promotion_id_fkey"
  FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
