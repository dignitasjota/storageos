-- Formas de pago sin pasarela que el inquilino puede elegir al reservar o
-- pagar una factura (cada una la activa el tenant).
ALTER TABLE "tenants"
  ADD COLUMN "offline_transfer_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "offline_cash_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "offline_sepa_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Lo que eligió el inquilino para pagar la primera factura de la reserva
-- (bank_transfer | cash | sepa_debit). Elegir transferencia o pago en el local
-- amplía una vez el plazo de la reserva.
ALTER TABLE "contracts"
  ADD COLUMN "offline_payment_method" TEXT,
  ADD COLUMN "offline_payment_chosen_at" TIMESTAMPTZ(6);
