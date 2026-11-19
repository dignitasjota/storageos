-- Informes: cada informe guarda los locales de quien lo pidió, para que salga
-- solo con lo que esa persona puede ver.
ALTER TABLE "report_runs"
  ADD COLUMN "facility_scoped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "facility_scope" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
