-- Blog del tenant (SEO de contenido para su web pública, feature `web_premium`).
CREATE TABLE "blog_posts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "content_markdown" TEXT NOT NULL,
    "cover_image_key" TEXT,
    "seo_title" TEXT,
    "seo_description" TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blog_posts_tenant_id_slug_key" ON "blog_posts" ("tenant_id", "slug");
CREATE INDEX "blog_posts_tenant_id_is_published_published_at_idx"
    ON "blog_posts" ("tenant_id", "is_published", "published_at");

ALTER TABLE "blog_posts"
    ADD CONSTRAINT "blog_posts_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "blog_posts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "blog_posts";
CREATE POLICY tenant_isolation ON "blog_posts" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
