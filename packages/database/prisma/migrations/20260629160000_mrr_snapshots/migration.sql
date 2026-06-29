-- Snapshot mensual del MRR por tenant (1 fila por tenant y mes). Base de los
-- MRR movements: comparando meses consecutivos se derivan
-- new/expansion/contraction/churn/reactivation.
CREATE TABLE "mrr_snapshots" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "plan_slug" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mrr" DECIMAL(12, 2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "mrr_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mrr_snapshots_tenant_id_month_key" ON "mrr_snapshots" ("tenant_id", "month");
CREATE INDEX "mrr_snapshots_month_idx" ON "mrr_snapshots" ("month");

ALTER TABLE "mrr_snapshots"
    ADD CONSTRAINT "mrr_snapshots_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
