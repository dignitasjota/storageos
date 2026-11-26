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
