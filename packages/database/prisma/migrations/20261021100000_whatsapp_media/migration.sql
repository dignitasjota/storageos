-- Fotos, audios, vídeos y documentos en las conversaciones de WhatsApp. El
-- archivo se guarda en el almacenamiento privado (`media_key`, bucket uploads).
ALTER TABLE "whatsapp_messages"
  ADD COLUMN "media_type" TEXT,
  ADD COLUMN "media_key" TEXT,
  ADD COLUMN "media_mime" TEXT,
  ADD COLUMN "media_filename" TEXT,
  ADD COLUMN "media_size" INTEGER;
