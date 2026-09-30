-- Correos automáticos del tenant a sus inquilinos (factura emitida, pago
-- recibido, contrato firmado, fin de contrato, baja, cobro rechazado).
-- Activados por defecto: el jsonb solo guarda los que el tenant apaga
-- (`{"invoice_issued": false}`); una clave ausente = activado.
ALTER TABLE "tenants" ADD COLUMN "customer_email_settings" JSONB NOT NULL DEFAULT '{}'::jsonb;
