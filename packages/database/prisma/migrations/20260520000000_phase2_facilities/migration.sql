-- CreateEnum
CREATE TYPE "unit_status" AS ENUM ('available', 'occupied', 'reserved', 'maintenance', 'blocked');

-- CreateTable
CREATE TABLE "facilities" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "country" CHAR(2) NOT NULL DEFAULT 'ES',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid',
    "opening_hours" JSONB NOT NULL DEFAULT '{}',
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility_floors" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "facility_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "floor_number" INTEGER NOT NULL DEFAULT 0,
    "plan_image_url" TEXT,
    "plan_width_px" INTEGER,
    "plan_height_px" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "facility_floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_types" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_price_monthly" DECIMAL(10,2) NOT NULL,
    "color" CHAR(7) NOT NULL DEFAULT '#888888',
    "features" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "unit_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "floor_id" UUID NOT NULL,
    "unit_type_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "width_m" DECIMAL(6,2) NOT NULL,
    "depth_m" DECIMAL(6,2) NOT NULL,
    "height_m" DECIMAL(6,2) NOT NULL,
    "area_m2" DECIMAL(10,4),
    "volume_m3" DECIMAL(12,4),
    "status" "unit_status" NOT NULL DEFAULT 'available',
    "base_price_monthly" DECIMAL(10,2) NOT NULL,
    "plan_x" DECIMAL(10,3),
    "plan_y" DECIMAL(10,3),
    "plan_width" DECIMAL(10,3),
    "plan_height" DECIMAL(10,3),
    "plan_shape" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_status_history" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "previous_status" "unit_status" NOT NULL,
    "new_status" "unit_status" NOT NULL,
    "changed_by_user_id" UUID,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facilities_tenant_id_idx" ON "facilities"("tenant_id");

-- CreateIndex
CREATE INDEX "facilities_tenant_id_is_active_deleted_at_idx" ON "facilities"("tenant_id", "is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "facility_floors_facility_id_idx" ON "facility_floors"("facility_id");

-- CreateIndex
CREATE INDEX "unit_types_tenant_id_idx" ON "unit_types"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_types_tenant_id_name_key" ON "unit_types"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "units_tenant_id_idx" ON "units"("tenant_id");

-- CreateIndex
CREATE INDEX "units_facility_id_status_idx" ON "units"("facility_id", "status");

-- CreateIndex
CREATE INDEX "units_floor_id_idx" ON "units"("floor_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_facility_id_code_key" ON "units"("facility_id", "code");

-- CreateIndex
CREATE INDEX "unit_status_history_tenant_id_idx" ON "unit_status_history"("tenant_id");

-- CreateIndex
CREATE INDEX "unit_status_history_unit_id_occurred_at_idx" ON "unit_status_history"("unit_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_floors" ADD CONSTRAINT "facility_floors_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "facility_floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "units" ADD CONSTRAINT "units_unit_type_id_fkey" FOREIGN KEY ("unit_type_id") REFERENCES "unit_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_status_history" ADD CONSTRAINT "unit_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_status_history" ADD CONSTRAINT "unit_status_history_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_status_history" ADD CONSTRAINT "unit_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
