-- Citas del comercial con un prospecto o cliente (presencial, llamada o
-- videollamada), con fecha y hora. Avisan al comercial al asignárselas, el día
-- antes y una hora antes. Tabla global del panel de administración.
CREATE TABLE "sales_appointments" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "lead_id" UUID NOT NULL,
  "rep_id" UUID NOT NULL,
  -- in_person · call · video
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "starts_at" TIMESTAMPTZ(6) NOT NULL,
  "duration_minutes" INTEGER NOT NULL DEFAULT 30,
  -- Dirección, teléfono o enlace de la videollamada.
  "location" TEXT,
  "notes" TEXT,
  -- scheduled · done · cancelled · no_show
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "created_by_id" UUID,
  "day_reminder_sent_at" TIMESTAMPTZ(6),
  "hour_reminder_sent_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_appointments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "sales_appointments" ADD CONSTRAINT "sales_appointments_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "platform_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_appointments" ADD CONSTRAINT "sales_appointments_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_appointments" ADD CONSTRAINT "sales_appointments_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "sales_appointments_rep_idx" ON "sales_appointments"("rep_id", "starts_at");
CREATE INDEX "sales_appointments_lead_idx" ON "sales_appointments"("lead_id", "starts_at");
CREATE INDEX "sales_appointments_due_idx" ON "sales_appointments"("status", "starts_at");
REVOKE ALL ON "sales_appointments" FROM storageos_app;
