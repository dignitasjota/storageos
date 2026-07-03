-- Motor de add-ons facturables del SaaS: extras recurrentes (dominio propio,
-- usuarios/locales extra, IA…) que se suman a la suscripción del tenant. v1
-- desacoplado de Stripe: el importe efectivo (plan + add-ons) alimenta las
-- métricas y el pago manual; asignar un add-on con `feature` activa el override.

-- Catálogo global de add-ons (lo gestiona el super admin, como subscription_plans).
CREATE TABLE "subscription_addons" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_monthly" DECIMAL(12, 2) NOT NULL,
    -- Feature que se activa (override) al asignar el add-on; null = solo cobra.
    "feature" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "subscription_addons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subscription_addons_slug_key" ON "subscription_addons" ("slug");

-- Add-ons contratados por cada tenant (precio congelado al asignar).
CREATE TABLE "tenant_subscription_addons" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "addon_id" UUID NOT NULL,
    "price_monthly" DECIMAL(12, 2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tenant_subscription_addons_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tenant_subscription_addons_tenant_idx" ON "tenant_subscription_addons" ("tenant_id");
-- Un add-on una sola vez por tenant (usar quantity para varios).
CREATE UNIQUE INDEX "tenant_subscription_addons_unique" ON "tenant_subscription_addons" ("tenant_id", "addon_id");

ALTER TABLE "tenant_subscription_addons"
    ADD CONSTRAINT "tenant_subscription_addons_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_subscription_addons"
    ADD CONSTRAINT "tenant_subscription_addons_addon_id_fkey"
    FOREIGN KEY ("addon_id") REFERENCES "subscription_addons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS por coherencia (el tenant podrá leer sus add-ons); el super admin los
-- gestiona vía PrismaAdminService (bypass RLS), como tenant_subscription.
ALTER TABLE "tenant_subscription_addons" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_subscription_addons";
CREATE POLICY tenant_isolation ON "tenant_subscription_addons" FOR ALL TO storageos_app
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
