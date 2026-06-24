-- Rondas con checklist: puntos a marcar en una tarea (evidencia de inspección).
-- La plantilla define los puntos; cada tarea generada recibe su copia con estado.
ALTER TABLE "maintenance_plans" ADD COLUMN "checklist_template" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "tasks" ADD COLUMN "checklist" JSONB NOT NULL DEFAULT '[]';
