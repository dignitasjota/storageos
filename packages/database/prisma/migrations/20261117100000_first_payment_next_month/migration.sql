-- Primer pago mensual: a partir de este día del mes (hora del alta), la
-- primera factura cubre también el mes siguiente completo. NULL = desactivado.
ALTER TABLE "tenants" ADD COLUMN "first_payment_next_month_from_day" INTEGER DEFAULT 20;
