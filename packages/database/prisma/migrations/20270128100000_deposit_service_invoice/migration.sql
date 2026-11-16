-- Fianzas, tras la respuesta de la asesoría (2026-11-16):
-- 1. La parte de la fianza retenida que paga un servicio (limpieza, vaciado…)
--    se factura con IVA; el contrato guarda esa factura.
-- 2. Cada negocio decide si también deposita las fianzas de trasteros en el
--    organismo de su comunidad autónoma (las de vivienda siempre).

ALTER TABLE "contracts" ADD COLUMN "deposit_service_invoice_id" UUID;

ALTER TABLE "tenants" ADD COLUMN "deposit_registry_storage" BOOLEAN NOT NULL DEFAULT false;
