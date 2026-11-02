-- Blog del tenant: texto alternativo de la portada y entradas relacionadas
-- elegidas a mano (hasta 3; sin ninguna, la web muestra las últimas).
ALTER TABLE "blog_posts"
  ADD COLUMN "cover_image_alt" TEXT,
  ADD COLUMN "related_post_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
