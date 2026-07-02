-- Canal de origen de un mensaje del inquilino: portal (chat web), whatsapp o
-- email (respuestas entrantes por esos canales). Los mensajes del staff y los
-- ya existentes son 'portal'.
ALTER TABLE "customer_messages" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'portal';
