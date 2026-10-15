-- Redsys con pago por referencia: el primer pago guarda la tarjeta en Redsys y
-- las cuotas siguientes se cobran solas (cobro sin el cliente presente, MIT).
-- Lo tiene que activar el banco del tenant en su TPV.
ALTER TABLE "redsys_settings" ADD COLUMN "card_on_file_enabled" BOOLEAN NOT NULL DEFAULT false;
-- El inquilino pidió guardar la tarjeta en este pago.
ALTER TABLE "redsys_orders" ADD COLUMN "save_card" BOOLEAN NOT NULL DEFAULT false;
-- Id de la operación inicial (Ds_Merchant_Cof_Txnid): los cobros siguientes lo envían.
ALTER TABLE "payment_methods" ADD COLUMN "network_txn_id" TEXT;
