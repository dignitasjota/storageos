-- Cupones: descuento sobre el pago que se hace en ese momento (no sobre las
-- renovaciones). Distintos de las promociones del alta de contrato.
CREATE TABLE "coupons" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- percentage | fixed | free_months
  "discount_type" "promotion_discount_type" NOT NULL,
  -- % o € (percentage/fixed); en free_months, los meses regalados.
  "discount_value" DECIMAL(10,2) NOT NULL,
  -- Meses mínimos pagados por adelantado para que valga (1 = cualquiera).
  "min_months" INTEGER NOT NULL DEFAULT 1,
  -- Alquiler mínimo del periodo pagado (sin IVA), o null.
  "min_amount" DECIMAL(10,2),
  -- Vacío = vale para todos.
  "unit_type_ids" UUID[] NOT NULL DEFAULT '{}',
  "facility_ids" UUID[] NOT NULL DEFAULT '{}',
  "new_customers_only" BOOLEAN NOT NULL DEFAULT false,
  "max_uses" INTEGER,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "valid_from" TIMESTAMPTZ(6),
  "valid_until" TIMESTAMPTZ(6),
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "coupons_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coupons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "coupons_tenant_code_key" ON "coupons" ("tenant_id", "code");
CREATE INDEX "coupons_tenant_active_idx" ON "coupons" ("tenant_id", "is_active");

ALTER TABLE "coupons" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coupons" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- Cada uso de un cupón (qué contrato y factura, cuánto descontó).
CREATE TABLE "coupon_redemptions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "coupon_id" UUID NOT NULL,
  "customer_id" UUID,
  "contract_id" UUID,
  "invoice_id" UUID,
  "months" INTEGER NOT NULL,
  "discount_amount" DECIMAL(10,2) NOT NULL,
  "free_months" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coupon_redemptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "coupon_redemptions_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE,
  CONSTRAINT "coupon_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL,
  CONSTRAINT "coupon_redemptions_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL,
  CONSTRAINT "coupon_redemptions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL
);
CREATE INDEX "coupon_redemptions_coupon_idx" ON "coupon_redemptions" ("tenant_id", "coupon_id", "created_at");
-- Un cupón solo una vez por contrato.
CREATE UNIQUE INDEX "coupon_redemptions_contract_key" ON "coupon_redemptions" ("contract_id") WHERE "contract_id" IS NOT NULL;

ALTER TABLE "coupon_redemptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "coupon_redemptions" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
