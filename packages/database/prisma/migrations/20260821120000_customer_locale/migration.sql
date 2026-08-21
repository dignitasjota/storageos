-- Idioma preferido del inquilino en el portal ('es'|'en'), seleccionable desde
-- "Mis datos". Default 'es' (todos los clientes existentes).
ALTER TABLE "customers" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'es';
