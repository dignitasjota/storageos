-- Revisión de Inventario, PR B: movimientos de stock, stock mínimo,
-- documentos del local y fecha prevista de fin del mantenimiento.

ALTER TABLE "products" ADD COLUMN "min_stock" INTEGER;

CREATE TABLE "product_stock_movements" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "facility_id" UUID NOT NULL,
  "delta" INTEGER NOT NULL,
  "quantity_after" INTEGER,
  "kind" TEXT NOT NULL,
  "reason" TEXT,
  "sale_id" UUID,
  "user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "product_stock_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "product_stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE,
  CONSTRAINT "product_stock_movements_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE,
  CONSTRAINT "product_stock_movements_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "product_sales"("id") ON DELETE SET NULL,
  CONSTRAINT "product_stock_movements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "product_stock_movements_product_idx" ON "product_stock_movements" ("product_id", "created_at");

CREATE TABLE "facility_documents" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "facility_id" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "file_key" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "expires_on" DATE,
  "expiry_notified_at" TIMESTAMPTZ(6),
  "notes" TEXT,
  "uploaded_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "facility_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "facility_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "facility_documents_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE CASCADE,
  CONSTRAINT "facility_documents_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "facility_documents_facility_idx" ON "facility_documents" ("facility_id");
CREATE INDEX "facility_documents_expiry_idx" ON "facility_documents" ("tenant_id", "expires_on");

ALTER TABLE "units" ADD COLUMN "maintenance_until" DATE;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_stock_movements', 'facility_documents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO storageos_app USING (tenant_id = current_setting(''app.current_tenant'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant'', true)::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON "product_stock_movements", "facility_documents" TO storageos_app;
