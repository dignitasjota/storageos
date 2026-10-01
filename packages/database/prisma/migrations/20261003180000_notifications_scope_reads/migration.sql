-- Notificaciones del panel: alcance por local y leído por usuario.
--
-- 1) facility_id: local al que se refiere (null = toda la empresa). Un usuario
--    restringido a ciertos locales solo ve las suyas y las de empresa.
ALTER TABLE "notifications" ADD COLUMN "facility_id" UUID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2) Leído por usuario (antes `read_at` era único: si uno la marcaba leída,
--    desaparecía para todo el equipo).
CREATE TABLE "notification_reads" (
  "notification_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notification_id", "user_id"),
  CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id")
    REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_reads_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notification_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "notification_reads_tenant_user_idx" ON "notification_reads" ("tenant_id", "user_id");

ALTER TABLE "notification_reads" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "notification_reads";
CREATE POLICY tenant_isolation ON "notification_reads" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Lo ya leído (estado compartido de antes) queda leído para todo el equipo
-- actual, para no volver a encender el contador a nadie.
INSERT INTO "notification_reads" ("notification_id", "user_id", "tenant_id", "read_at")
SELECT n."id", u."id", n."tenant_id", n."read_at"
FROM "notifications" n
JOIN "users" u ON u."tenant_id" = n."tenant_id"
WHERE n."read_at" IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX "notifications_tenant_facility_idx" ON "notifications" ("tenant_id", "facility_id");
