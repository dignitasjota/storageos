-- Check-out con fotos: evidencia del estado del trastero a la salida (fianzas/disputas).
-- Las imágenes viven en MinIO (bucket privado `uploads`); aquí solo la key + metadatos.
CREATE TABLE "contract_checkout_photos" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "note" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "contract_checkout_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contract_checkout_photos_tenant_contract_idx"
    ON "contract_checkout_photos" ("tenant_id", "contract_id");

ALTER TABLE "contract_checkout_photos"
    ADD CONSTRAINT "contract_checkout_photos_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_checkout_photos"
    ADD CONSTRAINT "contract_checkout_photos_contract_id_fkey"
    FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contract_checkout_photos"
    ADD CONSTRAINT "contract_checkout_photos_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: aislamiento por tenant (rol de aplicación).
ALTER TABLE "contract_checkout_photos" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "contract_checkout_photos";
CREATE POLICY tenant_isolation ON "contract_checkout_photos" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
