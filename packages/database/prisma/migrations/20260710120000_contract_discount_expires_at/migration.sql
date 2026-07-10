-- Fecha de expiración del descuento recurrente del contrato. La fija la
-- aceptación de una oferta de retención (now + `months`); un cron la revierte al
-- vencer. NULL = sin expiración (descuentos de promoción no la usan, quedan
-- intactos ante el cron).
ALTER TABLE "contracts" ADD COLUMN "discount_expires_at" TIMESTAMPTZ(6);
