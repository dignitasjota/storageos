-- Resumen mensual del marketing por correo («Tu marketing en <mes>»).
-- Activado por defecto: solo se envía si el mes tuvo actividad.
ALTER TABLE "tenants"
  ADD COLUMN "marketing_report_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "marketing_report_last_month" TEXT;
