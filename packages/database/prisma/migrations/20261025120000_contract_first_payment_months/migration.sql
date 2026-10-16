-- Meses que cubre el primer pago del contrato (1 = mensual de siempre). Con
-- un cupón o varios meses por adelantado, la 1ª factura cubre esos meses y
-- después se factura mes a mes.
ALTER TABLE "contracts" ADD COLUMN "first_payment_months" INTEGER NOT NULL DEFAULT 1;
