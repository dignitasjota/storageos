-- BUG LATENTE: el unique (tenant, series, sequence_number) + drafts con
-- sequence_number=0 implicaba que solo podía existir UN borrador por serie —
-- la facturación recurrente con 2+ contratos activos fallaba en el segundo.
-- La unicidad de la numeración solo tiene sentido para facturas EMITIDAS
-- (sequence > 0, asignada por reserveNextNumber al emitir).
DROP INDEX IF EXISTS "invoices_tenant_id_series_id_sequence_number_key";

CREATE UNIQUE INDEX "invoices_series_sequence_unique"
    ON "invoices"("tenant_id", "series_id", "sequence_number")
    WHERE "sequence_number" > 0;
