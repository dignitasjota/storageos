-- Equipo comercial: garantía de la venta, tramos, bonus por objetivo y
-- «recibido» de las liquidaciones.

ALTER TABLE "sales_commission_plans"
  ADD COLUMN "guarantee_months" INTEGER,
  ADD COLUMN "sale_tiers" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "target_bonus" DECIMAL(10, 2) NOT NULL DEFAULT 0;

ALTER TABLE "sales_settlements"
  ADD COLUMN "received_at" TIMESTAMPTZ(6),
  ADD COLUMN "received_note" TEXT;

-- Descuentos y reintegros de una venta apuntan a la partida que corrigen.
ALTER TABLE "sales_commission_items" ADD COLUMN "related_item_id" UUID;
ALTER TABLE "sales_commission_items"
  ADD CONSTRAINT "sales_commission_items_related_item_id_fkey"
  FOREIGN KEY ("related_item_id") REFERENCES "sales_commission_items"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Un tramo y un bonus por comercial y mes como mucho.
CREATE UNIQUE INDEX "sales_commission_items_tier_key"
  ON "sales_commission_items"("rep_id", "month") WHERE "kind" = 'tier';
CREATE UNIQUE INDEX "sales_commission_items_bonus_key"
  ON "sales_commission_items"("rep_id", "month") WHERE "kind" = 'bonus';

-- El tramo y el bonus son del mes, no de un cliente.
ALTER TABLE "sales_commission_items" ALTER COLUMN "tenant_id" DROP NOT NULL;
