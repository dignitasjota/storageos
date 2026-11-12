-- Recibos devueltos: código de devolución SEPA y gastos por devolución
-- (2026-11-11).

-- Código de devolución (AM04, MD06…) de un cobro devuelto y de un adeudo
-- rechazado en una remesa.
ALTER TABLE payments ADD COLUMN return_code TEXT;
ALTER TABLE sepa_remittance_items ADD COLUMN return_code TEXT;

-- La factura de gastos por un recibo devuelto apunta a la devolución (el cobro
-- o el adeudo): una sola por devolución.
ALTER TABLE invoices ADD COLUMN return_fee_source_id UUID;
CREATE UNIQUE INDEX invoices_return_fee_source_unique
  ON invoices (tenant_id, return_fee_source_id)
  WHERE return_fee_source_id IS NOT NULL;
