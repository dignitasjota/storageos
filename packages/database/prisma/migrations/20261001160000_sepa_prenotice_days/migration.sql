-- Plazo de preaviso de los adeudos SEPA pactado con los inquilinos (por defecto
-- 14 días, el del reglamento SEPA si el contrato no fija otro). Al crear una
-- remesa con fecha de cargo dentro de ese plazo se avisa al operador.
ALTER TABLE "sepa_settings" ADD COLUMN "prenotice_days" INTEGER NOT NULL DEFAULT 14;
