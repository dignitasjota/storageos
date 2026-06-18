-- Landing SEO por local: slug público único por tenant.
ALTER TABLE "facilities" ADD COLUMN "public_slug" TEXT;

-- Backfill: slug a partir del nombre (minúsculas, no-alnum → '-', recortado),
-- desambiguando duplicados por tenant con un sufijo numérico.
WITH base AS (
  SELECT
    id,
    tenant_id,
    NULLIF(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), '') AS slug
  FROM "facilities"
),
numbered AS (
  SELECT
    id,
    slug,
    row_number() OVER (PARTITION BY tenant_id, slug ORDER BY id) AS rn
  FROM base
)
UPDATE "facilities" f
SET "public_slug" = CASE
  WHEN n.slug IS NULL THEN NULL
  WHEN n.rn = 1 THEN n.slug
  ELSE n.slug || '-' || n.rn
END
FROM numbered n
WHERE f.id = n.id;

CREATE UNIQUE INDEX "facilities_tenant_id_public_slug_key"
  ON "facilities"("tenant_id", "public_slug");
