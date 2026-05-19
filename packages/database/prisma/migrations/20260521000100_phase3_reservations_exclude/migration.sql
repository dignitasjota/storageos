-- EXCLUDE constraint para evitar overbooking en reservas.
--
-- Patron heredado de Asucar-Reservas (ADR-001 de ese proyecto). La idea:
-- una reserva ocupa un rango de tiempo `[valid_from, valid_until)` sobre
-- un unit. No puede haber dos reservas pending/confirmed solapando el
-- mismo unit. La regla se aplica a nivel de BD via constraint, no en el
-- servicio: imposible bypass desde un endpoint mal escrito.
--
-- Postgres permite EXCLUDE solo con tipos que tengan operador `&&`
-- (solapamiento). `tstzrange` lo tiene, pero `uuid` para `unit_id` no
-- tiene `=` indexable por GIST por defecto: hay que instalar la
-- extension `btree_gist` (combina los indices btree con gist).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Columna generada en Postgres con el rango. Prisma no la modela; el
-- servicio nunca la setea. Se mantiene siempre sincronizada con
-- valid_from y valid_until.
ALTER TABLE "reservations"
  ADD COLUMN "time_range" tstzrange
  GENERATED ALWAYS AS (tstzrange("valid_from", "valid_until", '[)')) STORED;

-- Constraint: imposible insertar dos reservas que solapen para el mismo
-- unit, si ambas estan en estado pending o confirmed. Las
-- expired/converted/cancelled NO bloquean.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlap_exclude"
  EXCLUDE USING gist (
    "unit_id"     WITH =,
    "time_range"  WITH &&
  ) WHERE (status IN ('pending', 'confirmed'));

-- Indice util para queries por rango (busqueda de huecos disponibles).
CREATE INDEX "reservations_time_range_idx"
  ON "reservations" USING gist ("time_range");
