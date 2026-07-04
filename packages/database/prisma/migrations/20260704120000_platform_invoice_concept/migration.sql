-- Concepto de la factura de plataforma (línea del PDF). Se rellena con la
-- descripción del pago (p. ej. «Add-on: Dominio propio»); si es null, el PDF
-- muestra «Suscripción {plan}» por defecto. Corrige que las facturas de cobros
-- de add-on salían etiquetadas como «Suscripción».
ALTER TABLE "platform_invoices" ADD COLUMN "concept" TEXT;
