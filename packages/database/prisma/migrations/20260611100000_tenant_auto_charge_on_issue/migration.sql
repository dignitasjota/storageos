-- Auto-charge al emitir factura (opt-in por tenant).
--
-- Cuando el flag esta activo, `AutoChargeService` (listener de
-- domain.invoice_issued) encola un job en la cola BullMQ `payments` que
-- cobra el pendiente de la factura al metodo de pago predeterminado del
-- cliente. Default false: el cobro sigue siendo manual salvo opt-in.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "auto_charge_on_issue" BOOLEAN NOT NULL DEFAULT false;
