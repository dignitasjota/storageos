-- Guardas de robustez contra ejecuciones concurrentes / réplicas.

-- (1) Dedupe de crons entre réplicas: cada cron "reclama" su ejecución diaria
-- insertando (name, run_on); la PK hace que solo una réplica gane. Global.
CREATE TABLE "cron_runs" (
    "name" TEXT NOT NULL,
    "run_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("name", "run_on")
);

-- (2) Anti-duplicado de la factura recurrente: el job hacía check-then-create
-- (TOCTOU). Una sola factura F1 viva por (tenant, contrato, inicio de periodo).
-- Índice PARCIAL: no afecta a rectificativas (R*), canceladas, borradas ni
-- facturas sin contrato/periodo. Vive solo en SQL (Prisma no representa
-- índices parciales), como el EXCLUDE de reservas.
CREATE UNIQUE INDEX "invoices_recurring_period_unique"
    ON "invoices"("tenant_id", "contract_id", "period_start")
    WHERE "contract_id" IS NOT NULL
      AND "period_start" IS NOT NULL
      AND "invoice_type" = 'F1'
      AND "status" <> 'cancelled'
      AND "deleted_at" IS NULL;

-- (3) Anti-duplicado de acciones de dunning ACTIVAS (scheduled/executed) por
-- (tenant, factura, tipo). Las canceladas no cuentan: re-agendar tras una
-- cancelación sigue permitido (mismo criterio que el check del service).
CREATE UNIQUE INDEX "dunning_actions_active_unique"
    ON "dunning_actions"("tenant_id", "invoice_id", "action_type")
    WHERE "status" IN ('scheduled', 'executed');
