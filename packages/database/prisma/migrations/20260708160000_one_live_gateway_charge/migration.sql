-- Anti-doble-cobro: como máximo UN cobro de pasarela (Stripe/GoCardless) no
-- fallido por factura. Garantía atómica a nivel BD contra el doble clic en
-- "Pagar" (dos requests concurrentes → el 2º INSERT viola el índice → 409).
--
-- Se EXCLUYEN los pagos `manual` (efectivo, transferencia, Redsys): admiten
-- varios (pagos parciales en efectivo) y Redsys es "avisar pero permitir".
-- Un reintento tras un pago `failed`/`refunded` sí se permite (no están en el
-- índice), así que un cobro rechazado se puede volver a intentar.
CREATE UNIQUE INDEX "payments_one_live_gateway_charge"
    ON "payments" ("invoice_id")
    WHERE "invoice_id" IS NOT NULL
      AND "gateway" IN ('stripe', 'gocardless')
      AND "status" IN ('pending', 'processing', 'succeeded');
