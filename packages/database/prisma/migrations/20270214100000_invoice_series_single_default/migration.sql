-- Una sola serie por defecto por emisor: el negocio (sin propietario) y cada
-- propietario. Antes lo garantizaba solo el código, y dos peticiones a la vez
-- podían dejar dos.

-- 1. Si hubiera varias por defecto del mismo emisor, se queda la más antigua
--    activa (y de facturas, no de rectificativas).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, owner_id
      ORDER BY is_active DESC, is_rectification ASC, created_at ASC, id ASC
    ) AS rn
  FROM invoice_series
  WHERE is_default
)
UPDATE invoice_series s
SET is_default = false, updated_at = now()
FROM ranked r
WHERE s.id = r.id AND r.rn > 1;

-- 2. Índice único parcial (Prisma no lo representa en schema.prisma).
CREATE UNIQUE INDEX "invoice_series_single_default"
  ON "invoice_series" ("tenant_id", COALESCE("owner_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "is_default";
