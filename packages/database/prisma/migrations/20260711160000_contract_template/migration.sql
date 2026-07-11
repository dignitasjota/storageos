-- Plantilla de contrato editable por el tenant: cláusulas particulares con
-- variables {{...}} que se renderizan al firmar y en el PDF.
ALTER TABLE "tenants" ADD COLUMN "contract_clauses" TEXT;

-- Snapshot del texto de condiciones firmado (cláusulas ya renderizadas): congela
-- lo firmado, así editar la plantilla no altera el PDF/prueba de contratos previos.
ALTER TABLE "contracts" ADD COLUMN "signed_terms_text" TEXT;
