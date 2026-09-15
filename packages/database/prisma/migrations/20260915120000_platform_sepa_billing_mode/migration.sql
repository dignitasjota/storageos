-- Cobro de la suscripción SaaS por SEPA directo (Fase 1: fontanería, sin
-- generación de remesas todavía). La plataforma pasa a poder domiciliar la
-- cuota de un tenant contra su propia cuenta bancaria (p.ej. BBVA), como
-- tercer modo de cobro junto a Stripe y manual — mismo patrón que el
-- SepaModule que cada tenant ya usa para domiciliar a sus inquilinos, pero
-- a nivel plataforma (deudor = el tenant).

-- Modo de cobro por tenant. Hasta ahora se inferia de stripe_subscription_id
-- IS NOT NULL; pasa a ser un campo explícito para poder representar 'sepa'
-- (sin objeto Stripe) sin ambigüedad.
ALTER TABLE "tenant_subscriptions" ADD COLUMN "billing_mode" TEXT NOT NULL DEFAULT 'manual';
UPDATE "tenant_subscriptions" SET "billing_mode" = 'stripe' WHERE "stripe_subscription_id" IS NOT NULL;

-- Acreedor SEPA de LA PLATAFORMA (singleton, sin tenant_id — misma fila para
-- todos los tenants en modo 'sepa'; findFirst() ?? create() en código, igual
-- que platform_dunning_settings). Sin RLS: tabla de plataforma, solo super admin.
CREATE TABLE "platform_sepa_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "creditor_name" TEXT NOT NULL DEFAULT '',
    "creditor_id" TEXT NOT NULL DEFAULT '',
    "creditor_iban_encrypted" TEXT,
    "creditor_bic" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_sepa_settings_pkey" PRIMARY KEY ("id")
);

-- Mandato SEPA de un TENANT autorizando a la plataforma a domiciliar su cuota
-- en su propia cuenta (el tenant es el deudor). Autoservicio: solo el propio
-- tenant lo crea/cancela; el admin únicamente lee/cancela por soporte.
-- Sin RLS (tabla de plataforma, consultada vía PrismaAdminService con
-- where:{tenantId} explícito, mismo patrón que tenant_subscription_addons).
CREATE TABLE "platform_sepa_mandates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "iban_encrypted" TEXT NOT NULL,
    "iban_last4" TEXT NOT NULL,
    "bic" TEXT,
    "signed_at" DATE NOT NULL,
    -- FRST hasta el primer cobro con éxito; luego RCUR.
    "sequence_type" TEXT NOT NULL DEFAULT 'FRST',
    -- active | cancelled. Un mandato activo por tenant, aplicado en código
    -- (soft-cancel-and-replace), igual que sepa_mandates hoy.
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_sepa_mandates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_sepa_mandates_tenant_id_reference_key" UNIQUE ("tenant_id", "reference")
);
CREATE INDEX "platform_sepa_mandates_tenant_id_status_idx" ON "platform_sepa_mandates" ("tenant_id", "status");
ALTER TABLE "platform_sepa_mandates" ADD CONSTRAINT "platform_sepa_mandates_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
