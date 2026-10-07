-- Primer día que factura la app en un contrato migrado de otro sistema: la
-- facturación recurrente no cobra nada anterior (lo facturó el sistema viejo).
-- null = desde el alta, como siempre.
ALTER TABLE "contracts" ADD COLUMN "billing_starts_on" DATE;
