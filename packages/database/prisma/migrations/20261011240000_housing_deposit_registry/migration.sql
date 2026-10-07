-- Fianza de una vivienda depositada en el organismo de la comunidad autónoma
-- (art. 36.6 LAU y normas autonómicas): organismo, fecha, nº de resguardo,
-- justificante y cuándo se recuperó al acabar el contrato.
ALTER TABLE "contracts" ADD COLUMN "deposit_registry_body" TEXT;
ALTER TABLE "contracts" ADD COLUMN "deposit_registered_at" DATE;
ALTER TABLE "contracts" ADD COLUMN "deposit_registry_reference" TEXT;
ALTER TABLE "contracts" ADD COLUMN "deposit_registry_receipt_key" TEXT;
ALTER TABLE "contracts" ADD COLUMN "deposit_registry_recovered_at" DATE;
