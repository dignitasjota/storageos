-- Fecha de fin que tenía el contrato antes de pedir la baja: si la baja se
-- cancela (o acepta una oferta para quedarse), se le devuelve.
ALTER TABLE "contracts" ADD COLUMN "end_date_before_ending" DATE;
