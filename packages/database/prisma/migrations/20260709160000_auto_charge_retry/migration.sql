-- Reintentos de cobro automático (smart retry): reintenta cobrar las facturas
-- VENCIDAS con método de pago cobrable, con backoff, antes de escalar al dunning.
ALTER TABLE "tenants"
    ADD COLUMN "auto_charge_retry_enabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "auto_charge_retry_max" INTEGER NOT NULL DEFAULT 3,
    ADD COLUMN "auto_charge_retry_interval_days" INTEGER NOT NULL DEFAULT 3;

-- Rastro de reintentos por factura (para el backoff y el tope de intentos).
ALTER TABLE "invoices"
    ADD COLUMN "auto_retry_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "auto_retry_last_at" TIMESTAMPTZ(6);
