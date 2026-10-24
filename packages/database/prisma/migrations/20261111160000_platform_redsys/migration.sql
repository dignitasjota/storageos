-- TPV virtual (Redsys) de la plataforma: los tenants pagan su suscripción con
-- tarjeta o Bizum. Tablas globales (la plataforma no es un tenant).
CREATE TABLE "platform_redsys_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "merchant_code" TEXT NOT NULL DEFAULT '',
  "terminal" TEXT NOT NULL DEFAULT '1',
  "secret_key_encrypted" TEXT,
  "environment" TEXT NOT NULL DEFAULT 'test',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "bizum_enabled" BOOLEAN NOT NULL DEFAULT false,
  "card_on_file_enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_redsys_settings_pkey" PRIMARY KEY ("id")
);

-- Un intento de pago de la suscripción por Redsys (número de pedido del TPV).
CREATE TABLE "platform_redsys_orders" (
  "order" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "pay_method" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "ds_response" TEXT,
  "payment_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "paid_at" TIMESTAMPTZ(6),
  CONSTRAINT "platform_redsys_orders_pkey" PRIMARY KEY ("order"),
  CONSTRAINT "platform_redsys_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_redsys_orders_tenant_status_idx" ON "platform_redsys_orders" ("tenant_id", "status");

-- Tablas globales: solo la conexión de administración.
REVOKE ALL ON "platform_redsys_settings" FROM storageos_app;
REVOKE ALL ON "platform_redsys_orders" FROM storageos_app;
