-- Adjuntos (imagen o PDF, bucket privado) en los tickets de soporte y en el chat
-- inquilino ↔ equipo. Un adjunto por mensaje.
ALTER TABLE "support_ticket_messages"
  ADD COLUMN "attachment_key" TEXT,
  ADD COLUMN "attachment_mime" TEXT,
  ADD COLUMN "attachment_name" TEXT;
ALTER TABLE "customer_messages"
  ADD COLUMN "attachment_key" TEXT,
  ADD COLUMN "attachment_mime" TEXT,
  ADD COLUMN "attachment_name" TEXT;
