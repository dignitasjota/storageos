-- Centro de ayuda: preguntas frecuentes que el staff define y el inquilino
-- consulta en su portal.
CREATE TABLE "faq_entries" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "faq_entries_tenant_id_idx" ON "faq_entries" ("tenant_id");

ALTER TABLE "faq_entries"
    ADD CONSTRAINT "faq_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "faq_entries" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "faq_entries";
CREATE POLICY tenant_isolation ON "faq_entries" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
