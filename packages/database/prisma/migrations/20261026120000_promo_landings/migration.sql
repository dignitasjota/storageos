-- Landings de promoción de la web del tenant (extra Web Premium): páginas
-- propias con su URL (`/promo/<slug>`), textos, foto, condiciones y, si se
-- quiere, un cupón que se aplica al reservar.
CREATE TABLE "promo_landings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  -- Nombre interno (solo en el panel).
  "name" TEXT NOT NULL,
  -- Dirección: /promo/<slug>.
  "slug" TEXT NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT false,
  -- Fechas opcionales: fuera de ellas la landing lleva a la web normal.
  "starts_at" TIMESTAMPTZ(6),
  "ends_at" TIMESTAMPTZ(6),
  "headline" TEXT NOT NULL,
  "subheadline" TEXT,
  -- Texto grande de la oferta («1 mes gratis», «-20 %»…).
  "offer_text" TEXT,
  "body" TEXT,
  "benefits" TEXT[] NOT NULL DEFAULT '{}',
  "conditions" TEXT,
  "cta_label" TEXT,
  "hero_image_key" TEXT,
  -- Cupón que se aplica al reservar desde la landing (opcional).
  "coupon_id" UUID,
  -- Vacío = todos los locales / tamaños.
  "facility_ids" UUID[] NOT NULL DEFAULT '{}',
  "unit_type_ids" UUID[] NOT NULL DEFAULT '{}',
  "show_countdown" BOOLEAN NOT NULL DEFAULT false,
  "show_testimonials" BOOLEAN NOT NULL DEFAULT true,
  "show_faq" BOOLEAN NOT NULL DEFAULT true,
  "show_contact" BOOLEAN NOT NULL DEFAULT true,
  "seo_title" TEXT,
  "seo_description" TEXT,
  -- Por defecto no se indexa (una promoción caducada no debe salir en Google).
  "indexable" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "promo_landings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promo_landings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "promo_landings_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "promo_landings_tenant_slug_key" ON "promo_landings" ("tenant_id", "slug");

ALTER TABLE "promo_landings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "promo_landings" FOR ALL TO storageos_app
  USING ("tenant_id" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.current_tenant', true)::uuid);
