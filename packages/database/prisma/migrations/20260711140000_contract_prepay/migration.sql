-- Prepago anual/semestral del inquilino con descuento.
-- billing_interval_months = frecuencia de facturación en meses: 1 (mensual, por
-- defecto), 6 (semestral), 12 (anual). Con interval>1 la recurrente emite UNA
-- factura que cubre N meses con `prepay_discount_pct` de descuento sobre el
-- alquiler. El path mensual (interval=1) no cambia.
ALTER TABLE "contracts"
  ADD COLUMN "billing_interval_months" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "prepay_discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0;
