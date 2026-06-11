-- Fase 11A.4: Rectificativas Veri*Factu (R1-R5).
--
-- Anade soporte para emitir facturas rectificativas segun RD 1619/2012 art. 13.
-- Las facturas rectificativas apuntan a la factura original via
-- `rectifies_invoice_id`. El metodo soportado en MVP es `by_differences`.
-- El enum `correction_method` declara `by_substitution` pero queda fuera de
-- alcance del MVP.

-- CreateEnum: invoice_type
CREATE TYPE "invoice_type" AS ENUM ('F1', 'F2', 'R1', 'R2', 'R3', 'R4', 'R5');

-- CreateEnum: correction_method
CREATE TYPE "correction_method" AS ENUM ('by_differences', 'by_substitution');

-- AlterTable: invoices
ALTER TABLE "invoices"
  ADD COLUMN "invoice_type" "invoice_type" NOT NULL DEFAULT 'F1',
  ADD COLUMN "rectifies_invoice_id" UUID,
  ADD COLUMN "rectification_reason" TEXT,
  ADD COLUMN "correction_method" "correction_method";

-- AddForeignKey
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_rectifies_invoice_id_fkey"
  FOREIGN KEY ("rectifies_invoice_id") REFERENCES "invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "invoices_rectifies_invoice_id_idx" ON "invoices"("rectifies_invoice_id");
