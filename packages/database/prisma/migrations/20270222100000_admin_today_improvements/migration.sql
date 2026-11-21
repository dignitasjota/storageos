-- «Hoy» del super admin: mejoras.

-- Trabajos fallidos de las colas que alguien ha marcado como revisados desde
-- «Hoy»: dejan de contar aunque no se reintenten. Se guarda cuándo falló: si
-- el mismo trabajo vuelve a fallar después, vuelve a salir.
CREATE TABLE "admin_reviewed_jobs" (
  "queue" TEXT NOT NULL,
  "job_id" TEXT NOT NULL,
  "failed_at" TIMESTAMPTZ(6) NOT NULL,
  "reviewed_by_id" UUID,
  "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "admin_reviewed_jobs_pkey" PRIMARY KEY ("queue", "job_id")
);
ALTER TABLE "admin_reviewed_jobs" ADD CONSTRAINT "admin_reviewed_jobs_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
REVOKE ALL ON "admin_reviewed_jobs" FROM storageos_app;

-- Última visita de cada super admin a «Hoy» y lo que había entonces (claves
-- de los avisos), para el resumen «Desde tu última visita».
CREATE TABLE "admin_today_visits" (
  "super_admin_id" UUID NOT NULL,
  "seen_at" TIMESTAMPTZ(6) NOT NULL,
  "snapshot" JSONB NOT NULL DEFAULT '[]',
  CONSTRAINT "admin_today_visits_pkey" PRIMARY KEY ("super_admin_id")
);
ALTER TABLE "admin_today_visits" ADD CONSTRAINT "admin_today_visits_super_admin_id_fkey"
  FOREIGN KEY ("super_admin_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "admin_today_visits" FROM storageos_app;
