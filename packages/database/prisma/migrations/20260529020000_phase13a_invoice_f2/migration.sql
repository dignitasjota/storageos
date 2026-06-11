-- Fase 13A.3: Factura simplificada F2 (cliente opcional) + rectificativas
-- por sustitucion.
--
-- F2 (RD 1619/2012 art. 7): factura simplificada para B2C de bajo importe sin
-- destinatario identificado. AEAT permite total <=400€ general o <=3000€ con
-- justificacion (reparacion, transporte, restauracion, parking, otros).
--
-- Para soportarlo el campo `customer_id` de `invoices` debe ser opcional:
-- en F2 puede ser null, en F1 sigue siendo obligatorio (validado a nivel de
-- aplicacion en `InvoicesService.create`).
--
-- No anadimos columnas adicionales: `is_simplified` se deriva siempre de
-- `invoice_type='F2'`. Por el mismo motivo el campo `correction_method`
-- (ya existente desde phase 11A.4) cubre `by_substitution` sin cambios de
-- schema.

ALTER TABLE "invoices" ALTER COLUMN "customer_id" DROP NOT NULL;
