-- Mantenimiento recurrente: plantillas que generan tareas automáticamente
-- según una frecuencia (diaria/semanal/mensual + intervalo).
CREATE TABLE "maintenance_plans" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "task_type" NOT NULL DEFAULT 'maintenance',
    "priority" "task_priority" NOT NULL DEFAULT 'normal',
    "facility_id" UUID,
    "assigned_to_user_id" UUID,
    "freq" TEXT NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "weekdays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "day_of_month" INTEGER,
    "start_date" DATE NOT NULL,
    "next_run_date" DATE NOT NULL,
    "last_generated_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_plans_tenant_id_idx" ON "maintenance_plans" ("tenant_id");
CREATE INDEX "maintenance_plans_active_next_run_idx"
    ON "maintenance_plans" ("is_active", "next_run_date");

ALTER TABLE "maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_facility_id_fkey"
    FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_assigned_to_user_id_fkey"
    FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "maintenance_plans" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "maintenance_plans";
CREATE POLICY tenant_isolation ON "maintenance_plans" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Trazabilidad: qué plan recurrente generó cada tarea (SET NULL si se borra el plan).
ALTER TABLE "tasks" ADD COLUMN "maintenance_plan_id" UUID;
ALTER TABLE "tasks"
    ADD CONSTRAINT "tasks_maintenance_plan_id_fkey"
    FOREIGN KEY ("maintenance_plan_id") REFERENCES "maintenance_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
