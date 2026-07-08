-- Anti-doble-ocupación: como máximo UN contrato vivo (active/ending) por trastero.
-- Garantía atómica a nivel BD contra dos firmas/traslados concurrentes sobre la
-- misma unidad (que leerían ambos "available" y la ocuparían → dos contratos en
-- el mismo trastero). Los draft/ended/cancelled no cuentan (varios borradores
-- pueden apuntar a la misma unidad antes de firmar). Complementa el advisory
-- lock que serializa `sign`/`changeUnit` (como ya hace el booking público).
CREATE UNIQUE INDEX "contracts_one_active_per_unit"
    ON "contracts" ("unit_id")
    WHERE "status" IN ('active', 'ending') AND "deleted_at" IS NULL;
