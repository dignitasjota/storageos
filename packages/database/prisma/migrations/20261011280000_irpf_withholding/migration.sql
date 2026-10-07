-- Retención de IRPF por contrato (alquiler a una empresa o profesional que
-- debe retener). La factura conserva su total (base + IVA, lo que se declara
-- en Veri*Factu); la retención se registra al emitir como un «pago» no
-- monetario (`withholding`), así lo pendiente = total − retención − cobros.
ALTER TYPE "payment_method_type" ADD VALUE IF NOT EXISTS 'withholding';

ALTER TABLE "contracts" ADD COLUMN "irpf_retention_pct" DECIMAL(5,2) NOT NULL DEFAULT 0;

ALTER TABLE "invoices" ADD COLUMN "withholding_pct" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "withholding_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;
