-- Marketing: seguridad (revisión de noviembre de 2026).

-- 1) Google Analytics: una propiedad solo puede estar en un negocio, y se
--    comprueba que mide su web (verified_at). Si alguna estaba en dos, se
--    queda en el que la conectó antes; el otro pierde la conexión y lo
--    descargado.
ALTER TABLE "tenant_ga4" ADD COLUMN "verified_at" TIMESTAMPTZ(6);

DELETE FROM "ga4_source_rows"
WHERE "tenant_id" IN (
  SELECT "tenant_id" FROM (
    SELECT "tenant_id",
           row_number() OVER (PARTITION BY "property_id" ORDER BY "created_at", "id") AS rn
    FROM "tenant_ga4"
  ) d WHERE d.rn > 1
);
DELETE FROM "ga4_page_rows"
WHERE "tenant_id" IN (
  SELECT "tenant_id" FROM (
    SELECT "tenant_id",
           row_number() OVER (PARTITION BY "property_id" ORDER BY "created_at", "id") AS rn
    FROM "tenant_ga4"
  ) d WHERE d.rn > 1
);
DELETE FROM "tenant_ga4"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           row_number() OVER (PARTITION BY "property_id" ORDER BY "created_at", "id") AS rn
    FROM "tenant_ga4"
  ) d WHERE d.rn > 1
);

CREATE UNIQUE INDEX "tenant_ga4_property_id_key" ON "tenant_ga4"("property_id");

-- 2) La página de firma mandaba a Google Analytics su dirección con el enlace
--    secreto: se borran de lo descargado (y de la analítica propia, por si acaso).
DELETE FROM "ga4_page_rows" WHERE "page_path" LIKE '%/sign/%';
DELETE FROM "web_events" WHERE "path" LIKE '%/sign/%';

-- 3) Negocios ya anonimizados: fuera sus credenciales de anuncios y sus
--    conexiones con Google (seguían en uso cada día).
DELETE FROM "google_ads_settings"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "meta_ads_settings"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "ga4_source_rows"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "ga4_page_rows"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "tenant_ga4"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "search_console_rows"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "tenant_search_console"
WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "deleted_at" IS NOT NULL);
