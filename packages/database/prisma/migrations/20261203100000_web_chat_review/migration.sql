-- Revisión del chat con IA de la web.

-- Respuestas de respaldo (sin IA: límite del mes, sin clave, error del modelo).
-- Se guardan para que la conversación no quede con la pregunta sin contestar,
-- pero no cuentan como respuestas del asistente.
ALTER TABLE "web_chat_messages" ADD COLUMN "fallback" BOOLEAN NOT NULL DEFAULT false;

-- Aviso (una vez al mes) de que el chat no responde porque falta la clave propia.
ALTER TABLE "tenants" ADD COLUMN "web_chat_key_notified" TEXT;
