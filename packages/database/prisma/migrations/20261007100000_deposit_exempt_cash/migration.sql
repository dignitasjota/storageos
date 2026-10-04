-- Inquilinos sin fianza (sus contratos nuevos salen con fianza 0) y fianza que
-- se cobra en efectivo en el local (fuera del pago online de la 1ª factura).
ALTER TABLE "customers" ADD COLUMN "deposit_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contracts" ADD COLUMN "deposit_payment_method" TEXT NOT NULL DEFAULT 'online';
