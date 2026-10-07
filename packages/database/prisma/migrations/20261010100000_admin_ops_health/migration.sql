-- Vigilancia operativa del super admin.
-- 1) Cada tarea programada (cron) registra su última ejecución y la siguiente
--    prevista: si la prevista pasa sin ejecutarse, el panel avisa.
CREATE TABLE "cron_heartbeats" (
  "name" TEXT NOT NULL,
  "process" TEXT NOT NULL,
  "expression" TEXT NOT NULL,
  "last_run_at" TIMESTAMPTZ(6),
  "next_run_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "cron_heartbeats_pkey" PRIMARY KEY ("name")
);
-- Tabla global (sin tenant): el rol de la app no la toca.
REVOKE ALL ON "cron_heartbeats" FROM storageos_app;

-- 2) Último aviso de caducidad enviado de cada certificado de la AEAT
--    (30, 15, 7 o 0 días): evita repetir el mismo aviso.
ALTER TABLE "tenant_aeat_credentials" ADD COLUMN "expiry_notified_days" INTEGER;
