-- Finalizar solo los contratos en baja cuando llega su fecha de fin (activado por defecto).
ALTER TABLE "tenants" ADD COLUMN "auto_end_contracts" BOOLEAN NOT NULL DEFAULT true;
