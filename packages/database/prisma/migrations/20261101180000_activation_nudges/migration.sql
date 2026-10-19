-- Correos de ayuda para arrancar durante la prueba según el uso (días 3, 7 y 12).
ALTER TABLE "platform_alert_settings" ADD COLUMN "send_activation" BOOLEAN NOT NULL DEFAULT true;
