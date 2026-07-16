-- Cámaras de seguridad y alarma (AirShield vía NVR): ingesta de EVENTOS +
-- SNAPSHOTS (no vídeo en vivo — eso va por la app oficial Dahua/DMSS). El evento
-- lo empuja el propio equipo (HTTP/FTP linkage), un agente on-site, o a futuro un
-- puente DSS: la ingesta es agnóstica del origen.

-- Dispositivo de cámara/alarma registrado por el operador.
CREATE TABLE "camera_devices" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- Canal en el NVR (1..n); relevante cuando la fuente es un NVR agregador.
    "channel" INTEGER NOT NULL DEFAULT 1,
    -- Nº de serie del equipo (para que el operador lo añada también a DMSS).
    "serial_number" TEXT,
    -- Token de ingesta (sha256 hex, único) que el equipo/agente presenta al
    -- empujar eventos. `preview` = primeros chars para identificarlo en la UI.
    "ingest_token_hash" TEXT NOT NULL,
    "ingest_token_preview" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_event_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "camera_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "camera_devices_ingest_token_hash_key" ON "camera_devices" ("ingest_token_hash");
CREATE INDEX "camera_devices_tenant_facility_idx" ON "camera_devices" ("tenant_id", "facility_id");

ALTER TABLE "camera_devices" ADD CONSTRAINT "camera_devices_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "camera_devices" ADD CONSTRAINT "camera_devices_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "camera_devices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "camera_devices";
CREATE POLICY tenant_isolation ON "camera_devices" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Evento recibido (movimiento, persona, línea, o alarma: armado/zona/tamper).
CREATE TABLE "camera_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "camera_device_id" UUID NOT NULL,
    -- 'camera' (evento de vídeo/IA) | 'alarm' (intrusión AirShield).
    "kind" TEXT NOT NULL DEFAULT 'camera',
    "event_type" TEXT NOT NULL,
    -- Key del snapshot en MinIO (bucket privado uploads); null si el evento no trae imagen.
    "snapshot_key" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "camera_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "camera_events_tenant_occurred_idx" ON "camera_events" ("tenant_id", "occurred_at" DESC);
CREATE INDEX "camera_events_device_occurred_idx" ON "camera_events" ("tenant_id", "camera_device_id", "occurred_at" DESC);

ALTER TABLE "camera_events" ADD CONSTRAINT "camera_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "camera_events" ADD CONSTRAINT "camera_events_camera_device_id_fkey"
    FOREIGN KEY ("camera_device_id") REFERENCES "camera_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "camera_events" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "camera_events";
CREATE POLICY tenant_isolation ON "camera_events" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
