-- SEO Avanzado: arreglos de la revisión (2026-11-26).

-- Search Console: hasta qué día se ha descargado con éxito (haya o no filas esos
-- días: Google no da fila de los días sin impresiones) y desde cuándo hay detalle
-- por búsqueda y página (los Excel importados solo traen el total diario).
ALTER TABLE "seo_project_domains"
  ADD COLUMN "synced_until" DATE,
  ADD COLUMN "detail_since" DATE;

-- Relleno de lo que ya hay: lo descargado hasta el día anterior a la última
-- descarga buena, y el detalle desde el primer día con filas de búsquedas.
UPDATE "seo_project_domains"
SET "synced_until" = ("last_synced_at" AT TIME ZONE 'UTC')::date - 1
WHERE "last_synced_at" IS NOT NULL AND "initial_done_at" IS NOT NULL;

UPDATE "seo_project_domains" d
SET "detail_since" = m.first_day
FROM (
  SELECT "domain_id", MIN("date") AS first_day
  FROM "seo_gsc_metrics"
  WHERE "grain" = 'query'
  GROUP BY "domain_id"
) m
WHERE m."domain_id" = d."id";

-- Una descarga «en curso» que lleva horas sin avanzar se da por caída.
ALTER TABLE "seo_sync_runs"
  ADD COLUMN "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

-- Brief de contenido: si se ha editado el Markdown, el borrador del blog sale de lo editado.
ALTER TABLE "seo_content_briefs"
  ADD COLUMN "content_edited" BOOLEAN NOT NULL DEFAULT false;

-- GA4 del proyecto de la plataforma: antes se quitaba el prefijo /s/<negocio> de las
-- rutas (las webs de los negocios se sumaban a «/», «/precios»…). Se descarta lo
-- guardado y se vuelve a descargar con la ruta entera.
DELETE FROM "seo_ga4_landing_daily"
WHERE "project_id" IN (SELECT "id" FROM "seo_projects" WHERE "tenant_id" IS NULL);

UPDATE "seo_projects"
SET "ga4_synced_at" = NULL, "ga4_initial_done_at" = NULL
WHERE "tenant_id" IS NULL AND "ga4_property_id" IS NOT NULL;
