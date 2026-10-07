-- Plantilla de contrato de vivienda (LAU), aparte de la de trasteros.
-- NULL = la base LAU que trae la aplicación.
ALTER TABLE "tenants" ADD COLUMN "housing_contract_clauses" TEXT;
