-- Páginas de zona de la web del tenant (`/trasteros-en-<zona>`): el texto
-- propio de la página de una ciudad con locales y las páginas de pueblos
-- cercanos donde no hay local (con el local más cercano).
CREATE TABLE "web_area_pages" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  -- Dirección: /trasteros-en-<slug>. Si coincide con la ciudad de un local,
  -- es el texto de la página de esa ciudad; si no, una página de zona cercana.
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- Solo páginas de zona cercana: los locales que se muestran.
  "facility_ids" UUID[] NOT NULL DEFAULT '{}',
  -- «Nuestro local más cercano está en Mislata, a 8 km» (zona cercana).
  "nearest_note" TEXT,
  "intro" TEXT,
  "nearby_areas" TEXT[] NOT NULL DEFAULT '{}',
  -- [{question, answer}]
  "faqs" JSONB NOT NULL DEFAULT '[]',
  "seo_title" TEXT,
  "seo_description" TEXT,
  "is_published" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "web_area_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "web_area_pages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "web_area_pages_tenant_slug_key" ON "web_area_pages" ("tenant_id", "slug");

ALTER TABLE "web_area_pages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "web_area_pages" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
