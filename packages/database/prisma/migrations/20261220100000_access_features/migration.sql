-- Accesos temporales de proveedores y equipo: sin inquilino, con titular.
ALTER TABLE "access_credentials" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "access_credentials"
  ADD COLUMN "holder_name" TEXT,
  ADD COLUMN "holder_kind" TEXT,
  ADD COLUMN "valid_from" TIMESTAMPTZ(6);

-- Estado real de los dispositivos.
ALTER TABLE "access_devices"
  ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ(6),
  ADD COLUMN "offline_notified_at" TIMESTAMPTZ(6);

-- Sincronización con terminales: qué falló.
ALTER TABLE "access_credential_sync" ADD COLUMN "last_error" TEXT;

-- Política de corte por impago y avisos de seguridad.
ALTER TABLE "tenants"
  ADD COLUMN "access_cut_mode" TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN "access_cut_days" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "access_alerts" JSONB NOT NULL DEFAULT '{}';
