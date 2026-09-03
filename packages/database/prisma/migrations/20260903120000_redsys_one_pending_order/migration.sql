-- Anti-doble-cobro Redsys: como máximo UNA orden `pending` por factura.
-- `createRedirect` no creaba ninguna fila en `payments` hasta que el webhook
-- confirmaba (a diferencia de Stripe/GoCardless, que reservan un `payment`
-- `processing` ANTES de cobrar) → el guard existente contra "pago en curso"
-- (que sólo mira `payments`) no veía nada y se podían generar N órdenes
-- Redsys `pending` simultáneas para la misma factura. Si el cliente pagaba
-- más de una (doble clic, dos pestañas), sólo la primera confirmación
-- saldaba la factura; las siguientes chocaban con `overpayment` en
-- `markPaidManually` y el dinero de más quedaba sin rastro accionable (solo
-- un `logger.warn`).
--
-- Garantía atómica a nivel BD, mismo patrón que
-- `payments_one_live_gateway_charge`: una orden `failed` (tras expirar/
-- fallar) sale del índice, así que un reintento legítimo tras un fallo
-- sigue permitido sin más — solo se bloquea tener DOS órdenes vivas a la
-- vez para la misma factura.
CREATE UNIQUE INDEX "redsys_orders_one_pending_per_invoice"
    ON "redsys_orders" ("invoice_id")
    WHERE "status" = 'pending';
