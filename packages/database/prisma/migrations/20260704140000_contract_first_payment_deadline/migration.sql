-- Plazo de pago de la 1ª factura para los contratos nacidos del self-service
-- del portal (contratar trastero adicional). Si la factura no se paga antes del
-- plazo, un cron cancela el contrato y libera la unidad (evita el «contrato
-- zombi» que ocupa inventario, factura y entra en dunning sin acceso ni pago).
ALTER TABLE "contracts" ADD COLUMN "first_payment_deadline" TIMESTAMPTZ(6);
