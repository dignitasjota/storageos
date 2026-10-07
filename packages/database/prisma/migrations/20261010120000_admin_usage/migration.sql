-- Uso por tenant visto desde el panel del super admin.
-- 1) Consumo del asistente de IA: una fila por llamada al modelo con los
--    tokens que devuelve el proveedor (el coste se estima al leer).
CREATE TABLE "ai_usage_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "user_id" UUID,
  "feature" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ai_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usage_events_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ai_usage_events_tenant_id_created_at_idx" ON "ai_usage_events"("tenant_id", "created_at");
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events"("created_at");
-- Solo la escribe y la lee el servicio con la conexión de administración.
REVOKE ALL ON "ai_usage_events" FROM storageos_app;

-- 2) Espacio que ocupa cada tenant en el almacenamiento de ficheros (MinIO),
--    medido una vez al día.
CREATE TABLE "tenant_storage_usage" (
  "tenant_id" UUID NOT NULL,
  "bytes" BIGINT NOT NULL DEFAULT 0,
  "objects" INTEGER NOT NULL DEFAULT 0,
  "by_bucket" JSONB NOT NULL DEFAULT '{}',
  "measured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_storage_usage_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "tenant_storage_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
REVOKE ALL ON "tenant_storage_usage" FROM storageos_app;
