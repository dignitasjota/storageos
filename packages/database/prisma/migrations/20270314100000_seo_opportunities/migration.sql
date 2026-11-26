-- SEO Avanzado, PR 4: motor de oportunidades propio con puntuación (§9, §18.6
-- y §19.3). Cada oportunidad es de un proyecto y de uno de sus dominios; la
-- clave estable (tipo, dominio y búsqueda) evita duplicados al recalcular. El
-- recálculo actualiza números y motivo, pero nunca pisa el estado, las notas
-- ni a quién está asignada; una descartada solo vuelve (como nueva y con aviso)
-- si su puntuación sube lo bastante.
--
-- `tenant_id` es el del proyecto (nulo = la plataforma), con su política de
-- filas como el resto de tablas de SEO Avanzado.

-- Umbrales del motor (los pesos van en `weights`, que ya existía) y fecha del
-- último cálculo.
ALTER TABLE "seo_projects"
  ADD COLUMN "opportunity_settings" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "opportunities_calculated_at" TIMESTAMPTZ(6);

CREATE TABLE "seo_opportunities" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID,
  "project_id" UUID NOT NULL,
  "domain_id" UUID,
  "domain" TEXT NOT NULL,
  -- near_top3 · near_page1 · commercial_deep · low_ctr · rising · falling ·
  -- demand_gap · sistrix · keyword_gap
  "type" TEXT NOT NULL,
  -- Resumen (sha1) de tipo + dominio + búsqueda.
  "key" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "page" TEXT,
  "target_url" TEXT,
  "score" INTEGER NOT NULL DEFAULT 0,
  "confidence" DECIMAL(3, 2) NOT NULL DEFAULT 0,
  -- Desglose de la puntuación por factor (peso, valor, puntos y motivo).
  "factors" JSONB NOT NULL DEFAULT '[]',
  -- Las cifras que la justifican, con su origen y su fecha.
  "metrics" JSONB NOT NULL DEFAULT '{}',
  -- gsc · sistrix
  "sources" TEXT[] NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL DEFAULT '',
  "action" TEXT NOT NULL DEFAULT '',
  -- new · seen · in_progress · done · dismissed
  "status" TEXT NOT NULL DEFAULT 'new',
  "dismiss_reason" TEXT,
  -- Puntuación que tenía al descartarla (vuelve si sube `reappearPoints`).
  "dismissed_score" INTEGER,
  "notes" TEXT,
  "assigned_to_user_id" UUID,
  "assigned_to_super_admin_id" UUID,
  -- Sigue saliendo en el último cálculo.
  "active" BOOLEAN NOT NULL DEFAULT true,
  "returned_at" TIMESTAMPTZ(6),
  "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "seo_opportunities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seo_opportunities_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_opportunities_project_id_fkey" FOREIGN KEY ("project_id")
    REFERENCES "seo_projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "seo_opportunities_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "seo_project_domains" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_opportunities_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id")
    REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "seo_opportunities_assigned_to_super_admin_id_fkey" FOREIGN KEY ("assigned_to_super_admin_id")
    REFERENCES "super_admins" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "seo_opportunities_project_key_key" ON "seo_opportunities" ("project_id", "key");
-- La lista: pendientes de un proyecto por puntuación.
CREATE INDEX "seo_opportunities_list_idx"
  ON "seo_opportunities" ("project_id", "status", "score" DESC);
CREATE INDEX "seo_opportunities_tenant_idx" ON "seo_opportunities" ("tenant_id");

ALTER TABLE "seo_opportunities" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "seo_opportunities" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
