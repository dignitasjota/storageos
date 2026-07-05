-- Cupones de descuento de PLATAFORMA (StorageOS -> tenant), aplicables al
-- cobro manual de la suscripción SaaS. Tabla global sin RLS (solo super admin).
-- OJO: distinta de `promo_codes` (esos son del negocio del TENANT a sus inquilinos).
CREATE TABLE "platform_coupons" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "code" TEXT NOT NULL,
  "discount_type" TEXT NOT NULL,
  "discount_value" NUMERIC(12, 2) NOT NULL,
  "valid_until" TIMESTAMPTZ(6),
  "max_uses" INTEGER,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_coupons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_coupons_code_key" ON "platform_coupons" ("code");
