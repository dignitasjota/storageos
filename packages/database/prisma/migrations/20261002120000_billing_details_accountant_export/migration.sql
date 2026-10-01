-- Datos fiscales del tenant como destinatario de las facturas de suscripción
-- (razón social y domicilio son obligatorios en una factura completa).
ALTER TABLE "tenants" ADD COLUMN "billing_legal_name" TEXT;
ALTER TABLE "tenants" ADD COLUMN "billing_address" TEXT;
ALTER TABLE "tenants" ADD COLUMN "billing_city" TEXT;
ALTER TABLE "tenants" ADD COLUMN "billing_postal_code" TEXT;

-- Negocio propio de la SL emisora: sus facturas a inquilinos entran en la
-- exportación para la asesoría junto a las de suscripción.
ALTER TABLE "platform_billing_settings" ADD COLUMN "own_tenant_id" UUID;
ALTER TABLE "platform_billing_settings"
  ADD CONSTRAINT "platform_billing_settings_own_tenant_id_fkey"
  FOREIGN KEY ("own_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
