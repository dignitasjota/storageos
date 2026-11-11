-- Contrato v2: la baja surte efecto a final de mes (por defecto), plazo para
-- devolver la fianza y gastos por recibo devuelto que figuran en el contrato.
ALTER TABLE "tenants"
  ADD COLUMN "move_out_end_of_month" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deposit_return_days" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "returned_payment_fee" DECIMAL(10,2);
