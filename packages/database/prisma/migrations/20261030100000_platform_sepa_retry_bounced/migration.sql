-- Un adeudo SEPA de plataforma devuelto por el banco tiene que poder volver a
-- domiciliarse por el mismo periodo. La unicidad (tenant, periodo) pasa a
-- contar solo los adeudos vivos (pendientes o cobrados), no los devueltos.
ALTER TABLE "platform_sepa_remittance_items"
  DROP CONSTRAINT "platform_sepa_remittance_items_tenant_period_key";

CREATE UNIQUE INDEX "platform_sepa_remittance_items_live_period"
  ON "platform_sepa_remittance_items" ("tenant_id", "period_covered")
  WHERE "item_status" IN ('pending', 'collected');
