-- Actualización anual de la renta en el aniversario de cada contrato, con el
-- porcentaje que fija el tenant (índice pactado). El sistema la propone; el
-- gestor la aplica.
ALTER TABLE "tenants" ADD COLUMN "anniversary_update_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "anniversary_update_pct" DECIMAL(5,2) NOT NULL DEFAULT 0;
-- housing = solo viviendas; all = viviendas y trasteros.
ALTER TABLE "tenants" ADD COLUMN "anniversary_update_scope" TEXT NOT NULL DEFAULT 'housing';
-- Último aniversario con la renta ya actualizada (o descartado).
ALTER TABLE "contracts" ADD COLUMN "last_anniversary_update_on" DATE;
