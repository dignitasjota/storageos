-- Convertir `units.area_m2` y `units.volume_m3` en columnas GENERATED
-- ALWAYS AS ... STORED. Prisma las modela como Decimal? optional pero
-- queremos que sean READ-ONLY a nivel de BD: nunca se setean desde la app.
--
-- DROP + ADD porque Postgres no permite convertir una columna normal a
-- generated con ALTER COLUMN. La tabla esta vacia en este momento (fase 2
-- recien creada), asi que no hay perdida de datos.

ALTER TABLE "units" DROP COLUMN "area_m2";
ALTER TABLE "units" DROP COLUMN "volume_m3";

ALTER TABLE "units"
  ADD COLUMN "area_m2" DECIMAL(10,4) GENERATED ALWAYS AS ("width_m" * "depth_m") STORED;

ALTER TABLE "units"
  ADD COLUMN "volume_m3" DECIMAL(12,4) GENERATED ALWAYS AS ("width_m" * "depth_m" * "height_m") STORED;
