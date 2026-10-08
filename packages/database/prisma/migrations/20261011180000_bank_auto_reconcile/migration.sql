-- Conciliación automática de extractos N43 (opcional por tenant): al importar,
-- un abono cuyo importe es exactamente lo pendiente de UNA factura y que lleva
-- su número en el concepto se concilia solo. Queda marcado y se puede deshacer.
ALTER TABLE "tenants" ADD COLUMN "bank_auto_reconcile" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bank_statement_transactions" ADD COLUMN "auto_matched" BOOLEAN NOT NULL DEFAULT false;
-- Cobro creado al conciliar (para deshacer exactamente ese).
ALTER TABLE "bank_statement_transactions" ADD COLUMN "matched_payment_id" UUID
  REFERENCES "payments"("id") ON DELETE SET NULL;
