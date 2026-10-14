-- Política de privacidad del tenant que el asistente de WhatsApp enlaza en su
-- primer mensaje (opcional).
ALTER TABLE "tenant_whatsapp_settings" ADD COLUMN "privacy_url" TEXT;
