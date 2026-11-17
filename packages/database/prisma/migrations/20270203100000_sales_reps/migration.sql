-- Comerciales: perfil «Comercial» del panel de administración, su cartera,
-- sus comisiones y sus herramientas. Todas las tablas nuevas son globales
-- (solo las usa el panel de administración): sin acceso para la app.

ALTER TYPE "super_admin_role" ADD VALUE IF NOT EXISTS 'sales';

-- Perfil del comercial: código para su enlace y su QR, y cómo contactarle.
ALTER TABLE "super_admins"
  ADD COLUMN "sales_code" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "whatsapp" TEXT,
  ADD COLUMN "booking_url" TEXT;
CREATE UNIQUE INDEX "super_admins_sales_code_key" ON "super_admins"("sales_code");

-- Avisos personales. Sin destinatario, el aviso es del equipo de
-- administración (como hasta ahora): los comerciales nunca lo ven.
ALTER TABLE "super_admin_notifications" ADD COLUMN "recipient_id" UUID;
ALTER TABLE "super_admin_notifications" ADD CONSTRAINT "super_admin_notifications_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "super_admin_notifications_recipient_idx"
  ON "super_admin_notifications"("recipient_id", "created_at" DESC);

-- Comercial de cada cuenta y de cada lead (quien cobra la comisión).
ALTER TABLE "tenants"
  ADD COLUMN "sales_rep_id" UUID,
  ADD COLUMN "sales_assigned_at" TIMESTAMPTZ(6),
  ADD COLUMN "sales_source" TEXT;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sales_rep_id_fkey"
  FOREIGN KEY ("sales_rep_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "tenants_sales_rep_idx" ON "tenants"("sales_rep_id") WHERE "sales_rep_id" IS NOT NULL;

ALTER TABLE "platform_leads"
  ADD COLUMN "sales_rep_id" UUID,
  ADD COLUMN "sales_assigned_at" TIMESTAMPTZ(6);
ALTER TABLE "platform_leads" ADD CONSTRAINT "platform_leads_sales_rep_id_fkey"
  FOREIGN KEY ("sales_rep_id") REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "platform_leads_sales_rep_idx" ON "platform_leads"("sales_rep_id") WHERE "sales_rep_id" IS NOT NULL;

-- Propuestas: cuándo la abrió, hasta cuándo vale y el recordatorio.
ALTER TABLE "platform_quote_offers"
  ADD COLUMN "opened_at" TIMESTAMPTZ(6),
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(6);

-- Cupones que pueden usar los comerciales en sus propuestas.
ALTER TABLE "platform_coupons" ADD COLUMN "sales_allowed" BOOLEAN NOT NULL DEFAULT false;

-- Historial de asignaciones (de quién fue cada cuenta o lead y desde cuándo).
CREATE TABLE "sales_assignments" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "rep_id" UUID NOT NULL,
  "tenant_id" UUID,
  "lead_id" UUID,
  -- link · code · created · lead · manual · import
  "source" TEXT NOT NULL,
  "assigned_by_id" UUID,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ended_at" TIMESTAMPTZ(6),
  -- reassigned · released · unassigned
  "ended_reason" TEXT,
  CONSTRAINT "sales_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sales_assignments_target_check" CHECK ("tenant_id" IS NOT NULL OR "lead_id" IS NOT NULL)
);
ALTER TABLE "sales_assignments" ADD CONSTRAINT "sales_assignments_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_assignments" ADD CONSTRAINT "sales_assignments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_assignments" ADD CONSTRAINT "sales_assignments_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "platform_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "sales_assignments_tenant_idx" ON "sales_assignments"("tenant_id", "started_at");
CREATE INDEX "sales_assignments_lead_idx" ON "sales_assignments"("lead_id", "started_at");
CREATE INDEX "sales_assignments_rep_idx" ON "sales_assignments"("rep_id", "started_at");
REVOKE ALL ON "sales_assignments" FROM storageos_app;

-- Ficha de llamada: lo que el comercial necesita ver de un vistazo.
CREATE TABLE "sales_account_profiles" (
  "lead_id" UUID NOT NULL,
  "pinned_note" TEXT,
  "status" TEXT,
  "temperature" TEXT,
  "decision_maker" TEXT,
  "best_time" TEXT,
  "next_action" TEXT,
  "last_outcome" TEXT,
  "last_contact_at" TIMESTAMPTZ(6),
  -- Lo que el comercial ya ha usado con esta cuenta (topes).
  "trial_extension_days" INTEGER NOT NULL DEFAULT 0,
  "addon_trials" INTEGER NOT NULL DEFAULT 0,
  "updated_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_account_profiles_pkey" PRIMARY KEY ("lead_id")
);
ALTER TABLE "sales_account_profiles" ADD CONSTRAINT "sales_account_profiles_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "platform_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "sales_account_profiles" FROM storageos_app;

-- Comisión de cada comercial: % de lo que facturan sus clientes, fijo por
-- venta, fijo por cada extra aprobado y conceptos propios (p. ej. migración).
CREATE TABLE "sales_commission_plans" (
  "rep_id" UUID NOT NULL,
  "revenue_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
  -- Meses desde el primer pago del cliente en que cuenta el % (null = siempre).
  "revenue_months" INTEGER,
  "per_sale_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "per_addon_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "updated_by_id" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_commission_plans_pkey" PRIMARY KEY ("rep_id")
);
ALTER TABLE "sales_commission_plans" ADD CONSTRAINT "sales_commission_plans_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "sales_commission_plans" FROM storageos_app;

CREATE TABLE "sales_commission_concepts" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "rep_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "amount" DECIMAL(10,2) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_commission_concepts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "sales_commission_concepts" ADD CONSTRAINT "sales_commission_concepts_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "sales_commission_concepts_rep_idx" ON "sales_commission_concepts"("rep_id");
REVOKE ALL ON "sales_commission_concepts" FROM storageos_app;

-- Extras contratados por clientes de un comercial: la comisión solo cuenta si
-- el administrador lo aprueba (el comercial medió en la venta).
CREATE TABLE "sales_addon_claims" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "tenant_addon_id" UUID NOT NULL,
  "addon_id" UUID NOT NULL,
  "rep_id" UUID NOT NULL,
  -- pending · approved · rejected
  "status" TEXT NOT NULL DEFAULT 'pending',
  -- Propuesta del comercial que incluía el extra (si la había).
  "offer_id" UUID,
  "rep_note" TEXT,
  -- Contratado antes del primer pago o antes de que el comercial llevara la
  -- cuenta: cuenta para el % sin pasar por aprobación (y sin fijo por extra).
  "part_of_sale" BOOLEAN NOT NULL DEFAULT false,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_addon_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_addon_claims_tenant_addon_key" ON "sales_addon_claims"("tenant_addon_id");
CREATE INDEX "sales_addon_claims_status_idx" ON "sales_addon_claims"("status", "created_at");
CREATE INDEX "sales_addon_claims_rep_idx" ON "sales_addon_claims"("rep_id", "created_at");
ALTER TABLE "sales_addon_claims" ADD CONSTRAINT "sales_addon_claims_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_addon_claims" ADD CONSTRAINT "sales_addon_claims_addon_id_fkey"
  FOREIGN KEY ("addon_id") REFERENCES "subscription_addons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_addon_claims" ADD CONSTRAINT "sales_addon_claims_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_addon_claims" ADD CONSTRAINT "sales_addon_claims_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "platform_quote_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
REVOKE ALL ON "sales_addon_claims" FROM storageos_app;

-- Liquidaciones mensuales de comisiones.
CREATE TABLE "sales_settlements" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "rep_id" UUID NOT NULL,
  "month" TEXT NOT NULL,
  "total" DECIMAL(12,2) NOT NULL,
  "items_count" INTEGER NOT NULL,
  -- pending_payment · paid
  "status" TEXT NOT NULL DEFAULT 'pending_payment',
  "paid_at" TIMESTAMPTZ(6),
  "paid_by_id" UUID,
  "note" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_settlements_rep_month_key" ON "sales_settlements"("rep_id", "month");
ALTER TABLE "sales_settlements" ADD CONSTRAINT "sales_settlements_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "sales_settlements" FROM storageos_app;

-- Cada comisión devengada (o pendiente de aprobar).
CREATE TABLE "sales_commission_items" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "rep_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  -- revenue (% de un cobro) · sale (fijo por venta) · addon_sale (fijo por
  -- extra aprobado) · concept (concepto propio) · adjustment (a mano)
  "kind" TEXT NOT NULL,
  "payment_id" UUID,
  "addon_id" UUID,
  "claim_id" UUID,
  "concept_id" UUID,
  "description" TEXT NOT NULL,
  -- Mes de devengo (AAAA-MM, hora de España).
  "month" TEXT NOT NULL,
  "base_amount" DECIMAL(12,2),
  "rate" DECIMAL(6,3),
  "amount" DECIMAL(12,2) NOT NULL,
  -- pending (a aprobar) · approved · rejected
  "status" TEXT NOT NULL DEFAULT 'approved',
  "settlement_id" UUID,
  "requested_by_id" UUID,
  "decided_by_id" UUID,
  "decided_at" TIMESTAMPTZ(6),
  "decision_note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_commission_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sales_commission_items_rep_month_idx" ON "sales_commission_items"("rep_id", "month");
CREATE INDEX "sales_commission_items_payment_idx" ON "sales_commission_items"("payment_id");
CREATE INDEX "sales_commission_items_status_idx" ON "sales_commission_items"("status", "created_at");
CREATE INDEX "sales_commission_items_settlement_idx" ON "sales_commission_items"("settlement_id");
-- Un fijo por venta por cuenta y un fijo por cada extra aprobado.
CREATE UNIQUE INDEX "sales_commission_items_sale_key" ON "sales_commission_items"("tenant_id") WHERE "kind" = 'sale';
CREATE UNIQUE INDEX "sales_commission_items_addon_sale_key" ON "sales_commission_items"("claim_id") WHERE "kind" = 'addon_sale';
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_payment_id_fkey"
  FOREIGN KEY ("payment_id") REFERENCES "tenant_subscription_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_claim_id_fkey"
  FOREIGN KEY ("claim_id") REFERENCES "sales_addon_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_concept_id_fkey"
  FOREIGN KEY ("concept_id") REFERENCES "sales_commission_concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales_commission_items" ADD CONSTRAINT "sales_commission_items_settlement_id_fkey"
  FOREIGN KEY ("settlement_id") REFERENCES "sales_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
REVOKE ALL ON "sales_commission_items" FROM storageos_app;

-- Objetivos mensuales de cada comercial.
CREATE TABLE "sales_targets" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "rep_id" UUID NOT NULL,
  "month" TEXT NOT NULL,
  "new_clients" INTEGER NOT NULL DEFAULT 0,
  "new_mrr" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_targets_rep_month_key" ON "sales_targets"("rep_id", "month");
ALTER TABLE "sales_targets" ADD CONSTRAINT "sales_targets_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "sales_targets" FROM storageos_app;

-- Ajustes del equipo comercial (un registro).
CREATE TABLE "platform_sales_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- Días de prueba de más para quien se registra con el código de un comercial.
  "signup_extra_trial_days" INTEGER NOT NULL DEFAULT 0,
  -- Un prospecto sin actividad en estos días deja de ser del comercial (0 = nunca).
  "lead_release_days" INTEGER NOT NULL DEFAULT 90,
  -- Días de prueba que el comercial puede añadir por cuenta, sin aprobación.
  "rep_trial_extension_days" INTEGER NOT NULL DEFAULT 14,
  -- Días de prueba de un extra (uno por cuenta), sin aprobación.
  "rep_addon_trial_days" INTEGER NOT NULL DEFAULT 14,
  -- Los correos de la prueba de sus clientes salen a nombre del comercial.
  "lifecycle_from_rep" BOOLEAN NOT NULL DEFAULT true,
  -- Cuenta de demostración para enseñar el producto (se reinicia cada noche).
  "demo_tenant_id" UUID,
  "demo_reset_enabled" BOOLEAN NOT NULL DEFAULT true,
  "demo_reset_at" TIMESTAMPTZ(6),
  "updated_by_id" UUID,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_sales_settings_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "platform_sales_settings" ADD CONSTRAINT "platform_sales_settings_demo_tenant_id_fkey"
  FOREIGN KEY ("demo_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
REVOKE ALL ON "platform_sales_settings" FROM storageos_app;
INSERT INTO "platform_sales_settings" ("id") VALUES (uuid_generate_v7());

-- Materiales de venta (dossier, tarifas, guion, objeciones…).
CREATE TABLE "sales_materials" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "title" TEXT NOT NULL,
  "description" TEXT,
  -- file · link · note
  "kind" TEXT NOT NULL,
  "url" TEXT,
  "file_key" TEXT,
  "file_name" TEXT,
  "mime_type" TEXT,
  "size_bytes" INTEGER,
  "body" TEXT,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_materials_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "sales_materials" FROM storageos_app;

-- Plantillas de correo y WhatsApp de los comerciales.
CREATE TABLE "sales_templates" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  -- email · whatsapp
  "channel" TEXT NOT NULL,
  "stage" TEXT,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_templates_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "sales_templates" FROM storageos_app;

-- Cadencias de contacto: pasos que crean los seguimientos del comercial.
CREATE TABLE "sales_cadences" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  "steps" JSONB NOT NULL DEFAULT '[]',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_cadences_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "sales_cadences" FROM storageos_app;

CREATE TABLE "sales_cadence_enrollments" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "cadence_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "rep_id" UUID NOT NULL,
  -- Seguimientos creados para cada paso (se borran los pendientes al pararla).
  "followup_ids" UUID[] NOT NULL DEFAULT '{}',
  -- active · done · stopped
  "status" TEXT NOT NULL DEFAULT 'active',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(6),
  CONSTRAINT "sales_cadence_enrollments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_cadence_enrollments_active_key"
  ON "sales_cadence_enrollments"("lead_id") WHERE "status" = 'active';
CREATE INDEX "sales_cadence_enrollments_rep_idx"
  ON "sales_cadence_enrollments"("rep_id", "status");
ALTER TABLE "sales_cadence_enrollments" ADD CONSTRAINT "sales_cadence_enrollments_cadence_id_fkey"
  FOREIGN KEY ("cadence_id") REFERENCES "sales_cadences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_cadence_enrollments" ADD CONSTRAINT "sales_cadence_enrollments_lead_id_fkey"
  FOREIGN KEY ("lead_id") REFERENCES "platform_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_cadence_enrollments" ADD CONSTRAINT "sales_cadence_enrollments_rep_id_fkey"
  FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
REVOKE ALL ON "sales_cadence_enrollments" FROM storageos_app;

-- Lo básico para empezar: una cadencia y unas plantillas (editables).
INSERT INTO "sales_cadences" ("name", "description", "steps") VALUES (
  'Nuevo registro',
  'Para quien acaba de crear su cuenta de prueba: llamada de bienvenida, ayuda con la puesta en marcha y propuesta antes de que acabe la prueba.',
  '[{"day":0,"channel":"call","title":"Llamada de bienvenida: qué necesita y cómo trabaja hoy"},{"day":2,"channel":"email","title":"Correo con los primeros pasos y una demo"},{"day":7,"channel":"call","title":"Revisar la puesta en marcha y resolver dudas"},{"day":21,"channel":"call","title":"Propuesta de plan antes de que acabe la prueba"}]'
);
INSERT INTO "sales_cadences" ("name", "description", "steps") VALUES (
  'Prospecto en frío',
  'Para un negocio que aún no conoce TrasterOS: tres intentos de contacto y un último correo.',
  '[{"day":0,"channel":"call","title":"Primera llamada: presentación y necesidades"},{"day":3,"channel":"whatsapp","title":"WhatsApp con un resumen y la demo"},{"day":7,"channel":"call","title":"Segunda llamada"},{"day":14,"channel":"email","title":"Último correo: dejar la puerta abierta"}]'
);
INSERT INTO "sales_templates" ("name", "channel", "stage", "subject", "body", "position") VALUES
  ('Primer contacto', 'email', 'new', 'Gestionar tus trasteros sin papeles',
   E'Hola {nombre}:\n\nSoy {comercial}, de TrasterOS. Ayudamos a negocios de trasteros como {empresa} a llevar contratos, cobros, accesos y facturación en un solo sitio.\n\n¿Te viene bien que te enseñe la aplicación en 20 minutos? Puedes elegir el momento aquí: {agenda}\n\nUn saludo,\n{comercial}\n{telefono_comercial}', 0),
  ('Bienvenida a la prueba', 'email', 'trial', 'Tu prueba de TrasterOS',
   E'Hola {nombre}:\n\nSoy {comercial} y te acompaño durante la prueba de {empresa}. Si quieres, montamos juntos los locales y los trasteros en una llamada.\n\nMi teléfono: {telefono_comercial}\n\nUn saludo,\n{comercial}', 1),
  ('Seguimiento por WhatsApp', 'whatsapp', 'contacted', NULL,
   E'Hola {nombre}, soy {comercial} de TrasterOS. ¿Pudiste ver la información que te envié? Si te va bien, te enseño la aplicación en 20 minutos: {agenda}', 2),
  ('Antes de que acabe la prueba', 'email', 'trial', 'Tu prueba de TrasterOS termina pronto',
   E'Hola {nombre}:\n\nA tu prueba de {empresa} le quedan pocos días. Si quieres seguir, te ayudo a elegir el plan que mejor encaja y a dejarlo todo listo.\n\nUn saludo,\n{comercial}\n{telefono_comercial}', 3);
