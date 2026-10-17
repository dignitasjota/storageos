-- Textos legales propios de la web pública del tenant (aviso legal, privacidad
-- y cookies, en Markdown). Vacío = se generan con sus datos de facturación.
ALTER TABLE "tenants" ADD COLUMN "web_legal" JSONB NOT NULL DEFAULT '{}';
