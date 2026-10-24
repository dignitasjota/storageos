-- Cobro automático de la suscripción con la tarjeta guardada en el TPV de la
-- plataforma (pago por referencia de Redsys).
ALTER TABLE "platform_redsys_orders"
  ADD COLUMN "save_card" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'redirect';

-- Tarjeta guardada de cada tenant (la referencia que devuelve Redsys).
CREATE TABLE "platform_redsys_cards" (
  "tenant_id" UUID NOT NULL,
  "identifier_encrypted" TEXT NOT NULL,
  "cof_txn_id" TEXT,
  "last4" TEXT,
  "brand" TEXT,
  "exp_month" INTEGER,
  "exp_year" INTEGER,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_redsys_cards_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "platform_redsys_cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);

REVOKE ALL ON "platform_redsys_cards" FROM storageos_app;
