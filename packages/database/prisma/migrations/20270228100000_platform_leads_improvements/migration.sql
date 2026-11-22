-- Mejoras de los leads del panel admin: conversación por correo, adjuntos,
-- seguimiento de la propuesta, secuencias automáticas, reparto automático,
-- fusión de duplicados, motivo de descarte y leads parados.

-- Leads ------------------------------------------------------------------------
ALTER TABLE "platform_leads"
  -- «No es un lead»: spam · supplier · support · existing_customer · merged · other
  ADD COLUMN "discard_reason_code" TEXT,
  ADD COLUMN "discard_reason" TEXT,
  -- Lead con el que se fusionó (el origen queda descartado).
  ADD COLUMN "merged_into_id" UUID,
  -- Parte variable de su dirección de respuesta (`p-<token>@<dominio>`).
  ADD COLUMN "reply_token" TEXT,
  -- Reparto automático: cuándo se le dio responsable y hasta cuándo tiene para responder.
  ADD COLUMN "auto_assigned_at" TIMESTAMPTZ(6),
  ADD COLUMN "response_due_at" TIMESTAMPTZ(6),
  -- Se pasó el plazo y se reasignó (una sola vez).
  ADD COLUMN "reassigned_at" TIMESTAMPTZ(6),
  -- Aviso de «parado»: una vez por lead y fase.
  ADD COLUMN "stale_notified_status" TEXT,
  ADD COLUMN "stale_notified_at" TIMESTAMPTZ(6),
  -- Sin correos automáticos de secuencia para este lead.
  ADD COLUMN "sequence_opt_out" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "platform_leads_merged_into_id_fkey" FOREIGN KEY ("merged_into_id")
    REFERENCES "platform_leads" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "platform_leads_reply_token_key" ON "platform_leads" ("reply_token");
CREATE INDEX "platform_leads_response_due_idx"
  ON "platform_leads" ("response_due_at")
  WHERE "response_due_at" IS NOT NULL AND "reassigned_at" IS NULL;

-- Los descartados de antes no tenían motivo.
UPDATE "platform_leads" SET "discard_reason_code" = 'other' WHERE "discarded_at" IS NOT NULL;

-- Actividad: adjuntos (imagen o PDF en el almacenamiento privado) -------------------
ALTER TABLE "platform_lead_activities"
  ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';

-- Propuestas: cuántas veces la abrió y el aviso (una vez por propuesta) ------------
ALTER TABLE "platform_quote_offers"
  ADD COLUMN "open_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_opened_at" TIMESTAMPTZ(6),
  ADD COLUMN "open_notified_at" TIMESTAMPTZ(6);

UPDATE "platform_quote_offers"
   SET "open_count" = 1, "last_opened_at" = "opened_at", "open_notified_at" = "opened_at"
 WHERE "opened_at" IS NOT NULL;

-- Ajustes de los leads (un registro) ----------------------------------------------
CREATE TABLE "platform_lead_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  -- off · round_robin · zone
  "assign_mode" TEXT NOT NULL DEFAULT 'off',
  -- Quién entra en el turno (en este orden).
  "round_robin_ids" UUID[] NOT NULL DEFAULT '{}',
  -- [{ "match": "valencia", "superAdminId": "…" }]: ciudad o provincia → persona.
  "zone_rules" JSONB NOT NULL DEFAULT '[]',
  -- Sin zona que case: por turnos (si hay gente en el turno).
  "zone_fallback_round_robin" BOOLEAN NOT NULL DEFAULT true,
  "last_assigned_id" UUID,
  "response_hours" INTEGER NOT NULL DEFAULT 4,
  -- Solo cuentan las horas laborables (lunes a viernes, de 9:00 a 18:00 en España).
  "business_hours" BOOLEAN NOT NULL DEFAULT false,
  "reassign_enabled" BOOLEAN NOT NULL DEFAULT true,
  -- Días sin actividad para darlo por parado, por fase.
  "stale_days" JSONB NOT NULL DEFAULT '{"new":1,"contacted":5,"interested":7,"trial":10}',
  -- A partir de esta cuota prevista (sin IVA) un lead parado cuenta como urgente.
  "high_value_monthly" DECIMAL(10, 2) NOT NULL DEFAULT 150,
  -- Empieza sola la secuencia por defecto con el primer correo o la propuesta.
  "sequence_auto_start" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_lead_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_lead_settings" FROM storageos_app;

-- Secuencias de correos ---------------------------------------------------------
CREATE TABLE "platform_lead_sequences" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "name" TEXT NOT NULL,
  "description" TEXT,
  -- [{ "day": 2, "templateId": "…" } | { "day": 2, "subject": "…", "body": "…" }]
  "steps" JSONB NOT NULL DEFAULT '[]',
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_lead_sequences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_lead_sequences_one_default"
  ON "platform_lead_sequences" ("is_default") WHERE "is_default";
REVOKE ALL ON "platform_lead_sequences" FROM storageos_app;

CREATE TABLE "platform_lead_sequence_enrollments" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "lead_id" UUID NOT NULL,
  "sequence_id" UUID NOT NULL,
  -- active · done · stopped
  "status" TEXT NOT NULL DEFAULT 'active',
  -- Siguiente paso por enviar (0 = el primero).
  "step_index" INTEGER NOT NULL DEFAULT 0,
  "next_run_at" TIMESTAMPTZ(6),
  "last_sent_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "finished_at" TIMESTAMPTZ(6),
  -- replied · stage · discarded · manual · no_email · finished
  "stop_reason" TEXT,
  "started_by_id" UUID,
  CONSTRAINT "platform_lead_sequence_enrollments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_lead_sequence_enrollments_lead_id_fkey" FOREIGN KEY ("lead_id")
    REFERENCES "platform_leads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_lead_sequence_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id")
    REFERENCES "platform_lead_sequences" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "platform_lead_sequence_enrollments_started_by_id_fkey" FOREIGN KEY ("started_by_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_lead_sequence_enrollments_active"
  ON "platform_lead_sequence_enrollments" ("lead_id") WHERE "status" = 'active';
CREATE INDEX "platform_lead_sequence_enrollments_due_idx"
  ON "platform_lead_sequence_enrollments" ("status", "next_run_at");
REVOKE ALL ON "platform_lead_sequence_enrollments" FROM storageos_app;

-- La secuencia de siempre: tres recordatorios si no contesta (días 2, 5 y 10).
INSERT INTO "platform_lead_sequences" ("name", "description", "steps", "is_active", "is_default")
VALUES (
  'Si no contesta',
  'Tres recordatorios cortos a los 2, 5 y 10 días del primer correo o de la propuesta. Se para solo si contesta, llamáis, tenéis una demo o una reunión, crea su cuenta o se pierde.',
  '[
    {"day": 2, "subject": "¿Pudiste verlo?", "body": "Hola {nombre}:\n\nTe escribí hace un par de días sobre TrasterOS para {empresa}. ¿Pudiste echarle un vistazo?\n\nSi te viene bien, te lo enseño en 20 minutos por videollamada.\n\nUn saludo."},
    {"day": 5, "subject": "Una idea para {empresa}", "body": "Hola {nombre}:\n\nCon TrasterOS los inquilinos reservan y pagan solos en tu web y el cobro de cada mes va en automático.\n\n¿Te cuento cómo lo haríamos en tu caso?\n\nUn saludo."},
    {"day": 10, "subject": "¿Lo dejamos para más adelante?", "body": "Hola {nombre}:\n\nNo quiero insistir más de la cuenta. Si ahora no es el momento, dímelo y te escribo más adelante; si te interesa, responde a este correo y lo vemos.\n\nUn saludo."}
  ]'::jsonb,
  true,
  true
);
