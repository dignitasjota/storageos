-- La fianza sale de la factura (auditoría de facturación, PR 6, decisión de
-- Jota). Era una línea al 0 % de la primera factura: contaba como base en el
-- libro de IVA, el 303, la exportación contable, Holded y las métricas, pero
-- una fianza no es una venta (es una garantía que se devuelve).
--
-- Ahora va en un «justificante de fianza» aparte: un documento en `invoices`
-- con `kind = 'deposit_receipt'`, sin número fiscal (FZ-<contrato>), sin
-- Veri*Factu y fuera de los informes fiscales, de Holded y de las métricas de
-- ingresos. Reutiliza los cobros de las facturas.
--   bundled_with_invoice_id: la factura con la que se cobra en un solo pago
--   (reserva online: el inquilino paga una vez y el cobro se reparte).
ALTER TABLE "invoices"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'invoice',
  ADD COLUMN "bundled_with_invoice_id" UUID;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_bundled_with_invoice_id_fkey"
  FOREIGN KEY ("bundled_with_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL;

CREATE INDEX "invoices_bundled_with_invoice_id_idx" ON "invoices" ("bundled_with_invoice_id")
  WHERE "bundled_with_invoice_id" IS NOT NULL;
