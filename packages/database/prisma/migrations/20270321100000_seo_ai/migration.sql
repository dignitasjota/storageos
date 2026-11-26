-- SEO Avanzado, PR 11 (fase 5): asistente de SEO con herramientas de solo
-- lectura y borradores de contenido (briefs) (§11 y §12 del plan).
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado. Las conversaciones son de
-- una persona: un usuario del negocio o un super admin.

-- ---------------------------------------------------------------------------
-- Conversaciones con el asistente de SEO, ligadas a un proyecto.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_ai_conversations" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "user_id" UUID,
  "super_admin_id" UUID,
  "title" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_ai_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_conversations_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_conversations_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_conversations_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- De una persona: o del equipo del negocio o un super admin.
  CONSTRAINT "seo_ai_conversations_owner_check"
    CHECK (("user_id" IS NULL) <> ("super_admin_id" IS NULL))
);
CREATE INDEX "seo_ai_conversations_project_idx"
  ON "seo_ai_conversations" ("project_id", "updated_at" DESC);
CREATE INDEX "seo_ai_conversations_tenant_idx" ON "seo_ai_conversations" ("tenant_id");

ALTER TABLE "seo_ai_conversations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ai_conversations" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

CREATE TABLE "seo_ai_messages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "conversation_id" UUID NOT NULL,
  -- user · assistant
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  -- Herramientas que consultó el asistente (se enseñan con la respuesta).
  "tools_used" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_ai_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "seo_ai_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "seo_ai_messages_conversation_idx"
  ON "seo_ai_messages" ("conversation_id", "created_at");
CREATE INDEX "seo_ai_messages_tenant_idx" ON "seo_ai_messages" ("tenant_id");

ALTER TABLE "seo_ai_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ai_messages" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Acciones que el asistente PROPONE y la persona confirma (o descarta):
-- crear una tarea SEO, registrar una actuación, poner una oportunidad en
-- curso o seguir una palabra. Nunca se ejecutan sin confirmar.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_ai_actions" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "message_id" UUID,
  "user_id" UUID,
  "super_admin_id" UUID,
  -- create_task · register_change · opportunity_in_progress · follow_keyword
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  -- proposed · executing · confirmed · discarded · failed
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "result" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  CONSTRAINT "seo_ai_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_ai_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_actions_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_actions_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "seo_ai_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_ai_actions_message_id_fkey" FOREIGN KEY ("message_id")
    REFERENCES "seo_ai_messages" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_ai_actions_conversation_idx" ON "seo_ai_actions" ("conversation_id");
CREATE INDEX "seo_ai_actions_tenant_idx" ON "seo_ai_actions" ("tenant_id");

ALTER TABLE "seo_ai_actions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_ai_actions" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Borradores de contenido (briefs) generados con IA desde una palabra, una
-- oportunidad, un grupo o una URL. Se editan, se exportan en Markdown y se
-- pueden pasar a una entrada en borrador del blog y a una tarea SEO.
-- ---------------------------------------------------------------------------

CREATE TABLE "seo_content_briefs" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  -- keyword · opportunity · group · url
  "source" TEXT NOT NULL,
  -- La palabra seguida, la oportunidad o el grupo de origen (si existe).
  "source_id" UUID,
  -- Lo que se ve del origen: la palabra, el nombre del grupo o la URL.
  "source_label" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "keywords" TEXT[] NOT NULL DEFAULT '{}',
  "target_url" TEXT,
  -- Estructura del brief (intención, H1/H2/H3, preguntas, enlaces, propuestas…).
  "structure" JSONB NOT NULL DEFAULT '{}',
  "content_markdown" TEXT NOT NULL,
  -- draft · in_progress · published
  "status" TEXT NOT NULL DEFAULT 'draft',
  "task_id" UUID,
  "change_id" UUID,
  "blog_post_id" UUID,
  "platform_blog_post_id" UUID,
  "created_by_user_id" UUID,
  "created_by_super_admin_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_content_briefs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_content_briefs_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_task_id_fkey" FOREIGN KEY ("task_id")
    REFERENCES "seo_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_change_id_fkey" FOREIGN KEY ("change_id")
    REFERENCES "seo_changes" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_blog_post_id_fkey" FOREIGN KEY ("blog_post_id")
    REFERENCES "blog_posts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_platform_blog_post_id_fkey" FOREIGN KEY ("platform_blog_post_id")
    REFERENCES "platform_blog_posts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_content_briefs_created_by_super_admin_id_fkey" FOREIGN KEY ("created_by_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "seo_content_briefs_project_idx"
  ON "seo_content_briefs" ("project_id", "updated_at" DESC);
CREATE INDEX "seo_content_briefs_tenant_idx" ON "seo_content_briefs" ("tenant_id");

ALTER TABLE "seo_content_briefs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_content_briefs" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Consumo de IA de la plataforma (asistente de SEO en los proyectos del panel
-- admin): tokens por llamada con la clave de la plataforma, sin tenant.
-- Tabla global: solo la conexión de administración.
-- ---------------------------------------------------------------------------

CREATE TABLE "platform_ai_usage_events" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "super_admin_id" UUID,
  "feature" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_ai_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_ai_usage_events_super_admin_id_fkey" FOREIGN KEY ("super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "platform_ai_usage_events_created_at_idx" ON "platform_ai_usage_events" ("created_at");
REVOKE ALL ON "platform_ai_usage_events" FROM storageos_app;
