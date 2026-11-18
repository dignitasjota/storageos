-- Revisión del equipo comercial.

-- Reparto de cada cobro entre plan y extras tal como era al cobrarse: un extra
-- contratado o quitado después no cambia la comisión de cobros anteriores.
ALTER TABLE "sales_commission_items" ADD COLUMN "split" JSONB;

-- Ventas (primer pago) por comercial y mes, con lo que aportaban entonces.
CREATE TABLE "sales_wins" (
  "tenant_id"  UUID          NOT NULL,
  "rep_id"     UUID          NOT NULL,
  "month"      TEXT          NOT NULL,
  "paid_at"    TIMESTAMPTZ(6) NOT NULL,
  "monthly"    DECIMAL(12, 2) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "sales_wins_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "sales_wins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_wins_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "super_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sales_wins_rep_month_idx" ON "sales_wins"("rep_id", "month");
REVOKE ALL ON "sales_wins" FROM storageos_app;


-- Un reinicio de la cuenta de demostración a la vez.
ALTER TABLE "platform_sales_settings" ADD COLUMN "demo_resetting_at" TIMESTAMPTZ(6);
