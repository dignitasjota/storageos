-- Última vez que el inquilino entró en su área de clientes (se anota como
-- mucho una vez por hora). Permite ver desde el panel quién la usa.
ALTER TABLE "customers" ADD COLUMN "portal_last_seen_at" TIMESTAMPTZ(6);
