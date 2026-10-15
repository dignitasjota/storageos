-- Idioma en el que escribe el contacto (lo detecta el asistente): los textos
-- fijos (aviso de IA, reserva, recordatorio) salen en ese idioma.
ALTER TABLE "whatsapp_conversations" ADD COLUMN "language" TEXT;
