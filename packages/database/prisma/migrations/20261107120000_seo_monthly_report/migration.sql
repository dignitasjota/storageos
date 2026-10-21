-- Informe mensual de SEO por correo (extra «SEO local»): activado por defecto.
ALTER TABLE "tenant_search_console" ADD COLUMN "monthly_report" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "tenant_search_console" ADD COLUMN "last_report_month" TEXT;
