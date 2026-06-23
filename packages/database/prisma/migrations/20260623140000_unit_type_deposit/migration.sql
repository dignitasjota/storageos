-- Fianza/depósito por tipo de trastero: se cobra junto a la 1ª mensualidad en la
-- reserva online (booking). Por defecto 0 (sin fianza).
ALTER TABLE "unit_types" ADD COLUMN "default_deposit_amount" DECIMAL(10, 2) NOT NULL DEFAULT 0;
