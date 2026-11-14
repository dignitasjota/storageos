-- Condiciones propias de cada contrato: texto libre que el equipo escribe en el
-- borrador y que va en lo que firma el inquilino, tras las condiciones generales.
ALTER TABLE "contracts" ADD COLUMN "specific_conditions" TEXT;
