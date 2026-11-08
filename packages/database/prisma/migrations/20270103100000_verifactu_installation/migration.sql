-- Número de instalación del sistema de cada negocio en sus registros de
-- Veri*Factu (2026-11-08). En un programa en la nube cada facturación es un
-- sistema distinto y su número no se repite nunca, ni al volver a activarlo
-- (preguntas frecuentes de la AEAT a desarrolladores, n.º 4). Se fija al
-- activar Veri*Factu: fecha y hora de la activación + el principio del id.
ALTER TABLE "tenants" ADD COLUMN "verifactu_installation" TEXT;

UPDATE "tenants"
SET "verifactu_installation" =
  to_char("verifactu_enabled_at" AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISS') || '-' || substr("id"::text, 1, 8)
WHERE "verifactu_enabled" AND "verifactu_enabled_at" IS NOT NULL;
