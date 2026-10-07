-- «Novedades»: entradas que publica el super admin y ven todos los tenants en
-- su panel. Global (sin tenant): el contenido es de la plataforma.
CREATE TABLE "product_updates" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'new',
  "feature" TEXT,
  "link" TEXT,
  "published_at" TIMESTAMPTZ(6),
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "product_updates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_updates_created_by_id_fkey" FOREIGN KEY ("created_by_id")
    REFERENCES "super_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "product_updates_published_at_idx" ON "product_updates"("published_at");
REVOKE ALL ON "product_updates" FROM storageos_app;

-- Hasta cuándo ha visto cada usuario las novedades (para el aviso de no leídas).
ALTER TABLE "users" ADD COLUMN "product_updates_seen_at" TIMESTAMPTZ(6);
