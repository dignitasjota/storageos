-- Pago de la suscripción por Redsys: meses que cubre la orden (pagar varios de una vez).
ALTER TABLE "platform_redsys_orders" ADD COLUMN "months" INTEGER NOT NULL DEFAULT 1;

-- Remesa SEPA de la plataforma preparada sola antes del vencimiento.
ALTER TABLE "platform_sepa_settings" ADD COLUMN "auto_prepare" BOOLEAN NOT NULL DEFAULT false;

-- Aviso al super admin de una remesa que lleva días sin confirmar (una vez).
ALTER TABLE "platform_sepa_remittances" ADD COLUMN "stale_notified_at" TIMESTAMPTZ(6);
