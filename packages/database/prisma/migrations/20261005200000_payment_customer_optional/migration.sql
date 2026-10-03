-- Auditoría de facturación, hallazgo 25: una factura simplificada (F2) sin
-- cliente cobrada a mano no creaba pago (customer_id era obligatorio), así que
-- no contaba en lo cobrado ni en el cierre de caja.
ALTER TABLE "payments" ALTER COLUMN "customer_id" DROP NOT NULL;
