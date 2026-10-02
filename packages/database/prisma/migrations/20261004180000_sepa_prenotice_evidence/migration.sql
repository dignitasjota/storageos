-- Constancia del preaviso SEPA en cada adeudo de la remesa. El deudor puede
-- reclamar un adeudo no autorizado hasta 13 meses después: hay que poder
-- demostrar que se le avisó. Antes solo quedaba el correo en Comunicaciones
-- (se borra a los 180 días o al anonimizar al inquilino) y, si el correo de
-- preaviso estaba apagado o el inquilino no tenía email, no quedaba nada.
--
-- prenotice_status: NULL = pendiente | sent | disabled | no_email | failed
ALTER TABLE "sepa_remittance_items"
  ADD COLUMN "prenotice_status" TEXT,
  ADD COLUMN "prenotice_at" TIMESTAMPTZ(6),
  ADD COLUMN "prenotice_recipient" TEXT,
  ADD COLUMN "prenotice_subject" TEXT,
  ADD COLUMN "prenotice_text" TEXT,
  ADD COLUMN "prenotice_communication_id" UUID,
  ADD CONSTRAINT "sepa_remittance_items_prenotice_communication_id_fkey"
    FOREIGN KEY ("prenotice_communication_id") REFERENCES "communications"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
