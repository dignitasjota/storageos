-- Revisión de Operaciones diarias.

-- El inquilino solo ve las incidencias que reportó él o las que el equipo marca
-- como visibles (antes veía todas las que llevaban su nombre, también las
-- notas internas sobre él).
ALTER TABLE "incidents" ADD COLUMN "visible_to_customer" BOOLEAN NOT NULL DEFAULT false;
UPDATE "incidents"
   SET "visible_to_customer" = true
 WHERE "reported_by_user_id" IS NULL
   AND "reported_by_external" LIKE 'Portal:%';

-- Día del mes en que se apuntó un vencimiento que se repite: uno del 31 vuelve
-- al 31 después de febrero (antes se quedaba en el 28).
ALTER TABLE "business_reminders" ADD COLUMN "anchor_day" SMALLINT;
UPDATE "business_reminders"
   SET "anchor_day" = EXTRACT(DAY FROM "due_date")::SMALLINT
 WHERE "recurrence" <> 'none';
