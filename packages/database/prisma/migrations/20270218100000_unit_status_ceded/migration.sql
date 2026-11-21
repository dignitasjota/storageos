-- Trasteros cedidos: el operador presta un trastero sin contrato ni cobro.
-- Estado propio del trastero, en su migración para poder usarlo en la siguiente
-- (un valor nuevo de un enum no se puede usar en la misma transacción).
ALTER TYPE "unit_status" ADD VALUE IF NOT EXISTS 'ceded';
