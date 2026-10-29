-- Vencimientos y avisos del negocio: plazos que el tenant apunta (renovar el
-- dominio, pagar el alquiler del local, presentar un modelo a Hacienda…) y que
-- el sistema le recuerda por correo, en la campana y en el móvil.

CREATE TABLE "business_reminders" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "facility_id" UUID,
  "title" TEXT NOT NULL,
  -- domain | hosting | rent | taxes | insurance | license | inspection |
  -- utilities | supplier | subscription | other
  "category" TEXT NOT NULL DEFAULT 'other',
  "due_date" DATE NOT NULL,
  -- none | monthly | quarterly | semiannual | yearly | custom (cada N meses)
  "recurrence" TEXT NOT NULL DEFAULT 'none',
  "interval_months" INTEGER,
  -- Días antes del vencimiento en los que avisar (0 = el mismo día).
  "notify_days_before" INTEGER[] NOT NULL DEFAULT ARRAY[30, 7, 1, 0],
  "notify_email" BOOLEAN NOT NULL DEFAULT true,
  "notify_in_app" BOOLEAN NOT NULL DEFAULT true,
  "notify_push" BOOLEAN NOT NULL DEFAULT true,
  -- managers = propietarios y gestores · users = personas concretas
  "recipient_mode" TEXT NOT NULL DEFAULT 'managers',
  "recipient_user_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  -- Correos fuera del equipo (asesoría, gestoría…).
  "extra_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Si pasa la fecha sin marcarlo hecho, un aviso al día hasta N días.
  "overdue_reminders" BOOLEAN NOT NULL DEFAULT true,
  "overdue_max_days" INTEGER NOT NULL DEFAULT 7,
  "amount" DECIMAL(12, 2),
  "vendor" TEXT,
  "link" TEXT,
  "notes" TEXT,
  -- active | paused | done (uno sin repetición ya hecho)
  "status" TEXT NOT NULL DEFAULT 'active',
  -- Pospuesto: no avisa hasta este día (y ese día vuelve a avisar).
  "snoozed_until" DATE,
  -- Plantilla de la que salió (para no añadirla dos veces).
  "template_key" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "business_reminders_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "business_reminders_due_idx"
  ON "business_reminders"("tenant_id", "status", "due_date");
ALTER TABLE "business_reminders"
  ADD CONSTRAINT "business_reminders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_reminders"
  ADD CONSTRAINT "business_reminders_facility_id_fkey"
  FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_reminders"
  ADD CONSTRAINT "business_reminders_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "business_reminders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "business_reminders" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_reminders" TO storageos_app;

-- Cada vez que se marca hecho: historial con el importe, el gasto apuntado y
-- el justificante.
CREATE TABLE "business_reminder_completions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "reminder_id" UUID NOT NULL,
  "due_date" DATE NOT NULL,
  "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_by_user_id" UUID,
  "note" TEXT,
  "amount" DECIMAL(12, 2),
  "expense_id" UUID,
  "receipt_key" TEXT,
  "receipt_name" TEXT,
  "receipt_mime" TEXT,
  CONSTRAINT "business_reminder_completions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "business_reminder_completions_reminder_idx"
  ON "business_reminder_completions"("reminder_id", "completed_at");
ALTER TABLE "business_reminder_completions"
  ADD CONSTRAINT "business_reminder_completions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_reminder_completions"
  ADD CONSTRAINT "business_reminder_completions_reminder_id_fkey"
  FOREIGN KEY ("reminder_id") REFERENCES "business_reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_reminder_completions"
  ADD CONSTRAINT "business_reminder_completions_completed_by_user_id_fkey"
  FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "business_reminder_completions"
  ADD CONSTRAINT "business_reminder_completions_expense_id_fkey"
  FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "business_reminder_completions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "business_reminder_completions" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_reminder_completions" TO storageos_app;

-- Avisos ya enviados: uno por vencimiento, fecha y hito («d30», «d7»,
-- «overdue:2026-10-29», «snooze:2026-11-02»). Evita repetirlos entre réplicas.
CREATE TABLE "business_reminder_notices" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "reminder_id" UUID NOT NULL,
  "due_date" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "business_reminder_notices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_reminder_notices_unique"
  ON "business_reminder_notices"("reminder_id", "due_date", "kind");
ALTER TABLE "business_reminder_notices"
  ADD CONSTRAINT "business_reminder_notices_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "business_reminder_notices"
  ADD CONSTRAINT "business_reminder_notices_reminder_id_fkey"
  FOREIGN KEY ("reminder_id") REFERENCES "business_reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "business_reminder_notices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "business_reminder_notices" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_reminder_notices" TO storageos_app;

-- Ajustes del tenant: resumen semanal (los lunes) y enlace de calendario (ICS).
ALTER TABLE "tenants"
  ADD COLUMN "reminders_weekly_digest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reminders_digest_last_date" DATE,
  ADD COLUMN "reminders_ics_token_hash" TEXT,
  ADD COLUMN "reminders_ics_token_encrypted" TEXT;
CREATE UNIQUE INDEX "tenants_reminders_ics_token_hash_key"
  ON "tenants"("reminders_ics_token_hash");

-- La función entra en los planes de pago (Starter, Pro y Administrador).
UPDATE "subscription_plans"
SET "tenant_features" = array_append("tenant_features", 'business_reminders')
WHERE "slug" IN ('starter', 'pro', 'administrador')
  AND NOT ('business_reminders' = ANY ("tenant_features"));
