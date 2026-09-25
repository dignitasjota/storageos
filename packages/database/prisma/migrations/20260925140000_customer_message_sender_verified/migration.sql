-- ¿Está autenticado el remitente del mensaje? Portal (sesión), staff y
-- WhatsApp (Meta firma el webhook) siempre lo están. Un email entrante solo si
-- el proveedor reporta DMARC `pass` para el `From`; si no, el mensaje entra
-- igualmente pero el panel lo marca como «remitente no verificado» (el `From`
-- de un email lo puede falsificar cualquiera).
ALTER TABLE "customer_messages" ADD COLUMN "sender_verified" BOOLEAN NOT NULL DEFAULT true;
