-- Las series «por año» (FA/2026/00213) no reiniciaban el contador al cambiar
-- de año: la primera de 2027 salía FA/2027/00214. Cada serie guarda ahora el
-- año de su numeración y el contador vuelve a 1 con el primer número del año.
ALTER TABLE "invoice_series" ADD COLUMN "numbering_year" INTEGER;

-- Año de la última factura emitida de la serie; sin ninguna, el actual (así
-- una serie con facturas de este año no reinicia el contador ahora).
UPDATE "invoice_series" s
SET "numbering_year" = COALESCE(
  (SELECT MAX(EXTRACT(YEAR FROM i."issue_date"))::int
     FROM "invoices" i
    WHERE i."series_id" = s."id" AND i."sequence_number" > 0 AND i."issue_date" IS NOT NULL),
  EXTRACT(YEAR FROM now())::int
);

-- El mismo número puede repetirse en años distintos (FA/2026/00001 y
-- FA/2027/00001); dentro del año sigue siendo único.
DROP INDEX IF EXISTS "invoices_series_sequence_unique";
CREATE UNIQUE INDEX "invoices_series_sequence_unique"
    ON "invoices"("tenant_id", "series_id", (EXTRACT(YEAR FROM "issue_date")), "sequence_number")
    WHERE "sequence_number" > 0;
