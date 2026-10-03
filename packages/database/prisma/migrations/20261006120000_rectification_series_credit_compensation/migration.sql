-- Segunda auditoría de facturación (PR 1).
--
-- 1) Las facturas rectificativas deben ir en una serie propia (RD 1619/2012,
--    art. 6): serie marcada como de rectificativas, que la app crea sola.
ALTER TABLE "invoice_series"
  ADD COLUMN "is_rectification" BOOLEAN NOT NULL DEFAULT false;

-- 2) Pago de compensación: una rectificativa de abono sobre una factura con
--    importe pendiente lo compensa (no es dinero cobrado: no cuenta en lo
--    cobrado, la caja ni los reembolsos).
ALTER TYPE "payment_method_type" ADD VALUE IF NOT EXISTS 'credit_note';
