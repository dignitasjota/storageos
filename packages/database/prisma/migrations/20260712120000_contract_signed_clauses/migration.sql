-- Snapshot de las cláusulas particulares RENDERIZADAS que se firmaron (aparte del
-- `signed_terms_text` que es el texto completo). Permite que el PDF de un contrato
-- ya firmado muestre EXACTAMENTE las cláusulas firmadas aunque se edite la
-- plantilla del tenant después.
ALTER TABLE "contracts" ADD COLUMN "signed_clauses_text" TEXT;
