-- SEO Avanzado, PR 6 (fase 3): el plan (§8, §15.2, §18.8 y §19.6).
--
-- Actuaciones (`seo_changes`): cada cambio hecho en la web, con su fecha y
-- hora (hora de España), su tipo y su alcance (URLs normalizadas y palabras),
-- para compararlo 7, 28 y 90 días antes y después con lo que da Search
-- Console. La comparación se calcula al leer: las cifras salen de
-- `seo_gsc_metrics` y no se guardan.
--
-- Tareas (`seo_tasks`): las del proyecto SEO, en su propia tabla y no en
-- `tasks` (la operativa del negocio), porque un proyecto puede ser de la
-- plataforma (sin tenant) y la tarea lleva URL, palabras y enlaces a lo que la
-- motivó. El calendario de contenidos es una vista de estas tareas (fecha de
-- publicación), no un módulo aparte.
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

CREATE TABLE "seo_changes" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  -- Día del cambio en hora de España (las ventanas se cuentan desde aquí).
  "change_date" DATE NOT NULL,
  "changed_at" TIMESTAMPTZ(6) NOT NULL,
  -- HH:MM en hora de España (null = sin hora).
  "change_time" TEXT,
  -- title_meta · content · new_page · internal_links · redirect · technical · noindex · target_url · other
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  -- Como se apuntaron y normalizadas (las que se comparan).
  "urls" TEXT[] NOT NULL DEFAULT '{}',
  "url_keys" TEXT[] NOT NULL DEFAULT '{}',
  "keywords" TEXT[] NOT NULL DEFAULT '{}',
  "notes" TEXT,
  "opportunity_id" UUID,
  "cannibalization_id" UUID,
  "index_finding_id" UUID,
  "task_id" UUID,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_changes_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_opportunity_id_fkey" FOREIGN KEY ("opportunity_id")
    REFERENCES "seo_opportunities" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_cannibalization_id_fkey" FOREIGN KEY ("cannibalization_id")
    REFERENCES "seo_cannibalizations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_index_finding_id_fkey" FOREIGN KEY ("index_finding_id")
    REFERENCES "seo_index_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_changes_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_changes_project_date_idx" ON "seo_changes" ("project_id", "change_date" DESC);
CREATE INDEX "seo_changes_tenant_idx" ON "seo_changes" ("tenant_id");

ALTER TABLE "seo_changes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_changes" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "seo_tasks" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  -- content · technical · links · local · other
  "type" TEXT NOT NULL DEFAULT 'other',
  -- todo · in_progress · review · done · cancelled
  "status" TEXT NOT NULL DEFAULT 'todo',
  -- high · medium · low
  "priority" TEXT NOT NULL DEFAULT 'medium',
  "assigned_to_user_id" UUID,
  "assigned_to_super_admin_id" UUID,
  "due_date" DATE,
  -- Para las de contenido: el día que se publica (el calendario de contenidos).
  "publish_date" DATE,
  "url" TEXT,
  "keywords" TEXT[] NOT NULL DEFAULT '{}',
  "opportunity_id" UUID,
  "cannibalization_id" UUID,
  "index_finding_id" UUID,
  -- La actuación que se registró al cerrarla.
  "change_id" UUID,
  -- Orden dentro de su columna del tablero.
  "position" INTEGER NOT NULL DEFAULT 0,
  "completed_at" TIMESTAMPTZ(6),
  -- Avisos ya dados (uno por tarea y día): a quién se avisó de la asignación
  -- y cuándo, y último día en que se avisó de que vence o va atrasada.
  "assign_notified_to" UUID,
  "assign_notified_on" DATE,
  "due_notified_on" DATE,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_assigned_to_super_admin_id_fkey" FOREIGN KEY ("assigned_to_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_opportunity_id_fkey" FOREIGN KEY ("opportunity_id")
    REFERENCES "seo_opportunities" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_cannibalization_id_fkey" FOREIGN KEY ("cannibalization_id")
    REFERENCES "seo_cannibalizations" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_index_finding_id_fkey" FOREIGN KEY ("index_finding_id")
    REFERENCES "seo_index_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_change_id_fkey" FOREIGN KEY ("change_id")
    REFERENCES "seo_changes" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_tasks_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_tasks_board_idx" ON "seo_tasks" ("project_id", "status", "position");
CREATE INDEX "seo_tasks_due_idx" ON "seo_tasks" ("project_id", "due_date");
CREATE INDEX "seo_tasks_tenant_idx" ON "seo_tasks" ("tenant_id");

ALTER TABLE "seo_tasks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_tasks" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- La tarea de la que sale una actuación (las dos se enlazan).
ALTER TABLE "seo_changes"
  ADD CONSTRAINT "seo_changes_task_id_fkey" FOREIGN KEY ("task_id")
    REFERENCES "seo_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
