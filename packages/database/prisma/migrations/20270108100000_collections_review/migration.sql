-- Revisión de Cobros (PR A): conciliación sin duplicados y reversible, caja que
-- se reabre, método de cada devolución, fianza aplicada y Bizum como formas de
-- pago propias, y los pasos del impago que pide la condición 12 del contrato.

-- Formas de pago nuevas: la fianza retenida que se aplica a una factura (no es
-- dinero nuevo) y Bizum (hasta ahora se registraba como tarjeta).
ALTER TYPE "payment_method_type" ADD VALUE IF NOT EXISTS 'deposit';
ALTER TYPE "payment_method_type" ADD VALUE IF NOT EXISTS 'bizum';

-- Impago: el contrato se resuelve y los bienes se trasladan y custodian antes
-- de que se pueda disponer de ellos por los cauces legales.
ALTER TYPE "delinquency_case_status" ADD VALUE IF NOT EXISTS 'contract_resolved' AFTER 'resolution_pending';
ALTER TYPE "delinquency_case_status" ADD VALUE IF NOT EXISTS 'goods_moved' AFTER 'contract_resolved';

ALTER TABLE "delinquency_cases"
  ADD COLUMN "notice_days" INTEGER,
  ADD COLUMN "notice_tracking" TEXT,
  ADD COLUMN "notice_received_at" TIMESTAMPTZ(6),
  ADD COLUMN "contract_resolved_at" TIMESTAMPTZ(6),
  ADD COLUMN "goods_moved_at" TIMESTAMPTZ(6),
  ADD COLUMN "custody_location" TEXT;

-- Conciliación bancaria: el mismo extracto no se importa dos veces y un
-- movimiento repetido en dos descargas se reconoce; los cobros de cada apunte
-- quedan anotados para poder deshacerlo.
ALTER TABLE "bank_statements"
  ADD COLUMN "file_hash" TEXT,
  ADD COLUMN "warnings" TEXT[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX "bank_statements_tenant_file_hash_key"
  ON "bank_statements" ("tenant_id", "file_hash") WHERE "file_hash" IS NOT NULL;

ALTER TABLE "bank_statement_transactions"
  ADD COLUMN "fingerprint" TEXT,
  ADD COLUMN "matched_payment_ids" UUID[] NOT NULL DEFAULT '{}',
  -- Parte de un abono que no se aplicó a ninguna factura (se devuelve o queda
  -- como saldo a favor en el contrato de `credit_contract_id`).
  ADD COLUMN "unapplied_amount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "credit_contract_id" UUID;
ALTER TABLE "bank_statement_transactions"
  ADD CONSTRAINT "bank_statement_transactions_credit_contract_id_fkey"
  FOREIGN KEY ("credit_contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "bank_statement_transactions_tenant_fingerprint_key"
  ON "bank_statement_transactions" ("tenant_id", "fingerprint") WHERE "fingerprint" IS NOT NULL;
UPDATE "bank_statement_transactions"
  SET "matched_payment_ids" = ARRAY["matched_payment_id"]
  WHERE "matched_payment_id" IS NOT NULL;

-- Cierre de caja: se puede reabrir (con motivo) para registrar un cobro o una
-- devolución en efectivo de ese día; el cierre reabierto queda de constancia.
ALTER TABLE "cash_closures"
  ADD COLUMN "reopened_at" TIMESTAMPTZ(6),
  ADD COLUMN "reopened_by_user_id" UUID,
  ADD COLUMN "reopen_reason" TEXT;
ALTER TABLE "cash_closures"
  ADD CONSTRAINT "cash_closures_reopened_by_user_id_fkey"
  FOREIGN KEY ("reopened_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX IF EXISTS "cash_closures_tenant_global_date_key";
DROP INDEX IF EXISTS "cash_closures_tenant_facility_date_key";
CREATE UNIQUE INDEX "cash_closures_tenant_global_date_key"
  ON "cash_closures" ("tenant_id", "closure_date")
  WHERE "facility_id" IS NULL AND "reopened_at" IS NULL;
CREATE UNIQUE INDEX "cash_closures_tenant_facility_date_key"
  ON "cash_closures" ("tenant_id", "facility_id", "closure_date")
  WHERE "facility_id" IS NOT NULL AND "reopened_at" IS NULL;

-- Cada devolución guarda cómo se devolvió el dinero (la caja descuenta las
-- devueltas en efectivo el día en que se devuelven).
ALTER TABLE "invoice_refunds" ADD COLUMN "method" "payment_method_type";
CREATE INDEX "invoice_refunds_tenant_created_idx" ON "invoice_refunds" ("tenant_id", "created_at");

-- Remesas SEPA: cada adeudo cobrado apunta a su cobro (para marcarlo devuelto
-- desde la remesa y para que no se «deshaga» desde la factura).
ALTER TABLE "sepa_remittance_items" ADD COLUMN "payment_id" UUID;
ALTER TABLE "sepa_remittance_items"
  ADD CONSTRAINT "sepa_remittance_items_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sepa_remittance_items_payment_id_idx" ON "sepa_remittance_items" ("payment_id");

-- Redsys: con qué pidió pagar el inquilino (tarjeta o Bizum), para anotar el
-- cobro con su forma real (antes todo salía como tarjeta).
ALTER TABLE "redsys_orders" ADD COLUMN "pay_method" TEXT;
