-- Primera factura de una reserva online: se prepara al firmar como borrador
-- (sin número, sin huella ni QR) y se emite al cobrarse. El contrato entra en
-- vigor con el primer pago; si no se paga en plazo, el borrador se anula sin
-- gastar número ni hacer una rectificativa.

ALTER TABLE "invoices" ADD COLUMN "issue_on_payment" BOOLEAN NOT NULL DEFAULT false;

-- Borradores que esperan su cobro (caducidad de reservas, cobros del portal).
CREATE INDEX "invoices_issue_on_payment_idx"
  ON "invoices" ("tenant_id", "contract_id")
  WHERE "issue_on_payment" = true AND "status" = 'draft';
