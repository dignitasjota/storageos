-- Tracking de campañas (UTM) en leads: origen de captación capturado en el
-- widget/booking público desde los parámetros utm_* de la URL.
ALTER TABLE "leads" ADD COLUMN "utm_source" TEXT;
ALTER TABLE "leads" ADD COLUMN "utm_medium" TEXT;
ALTER TABLE "leads" ADD COLUMN "utm_campaign" TEXT;
