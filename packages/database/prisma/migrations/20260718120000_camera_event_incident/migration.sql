-- Vínculo evento de cámara/alarma → incidencia (cross-link operativo). Un evento
-- pertenece a 0-1 incidencia; una incidencia agrupa N eventos. ON DELETE SET NULL:
-- borrar la incidencia no borra los eventos, solo los desvincula.
ALTER TABLE "camera_events" ADD COLUMN "incident_id" UUID;
ALTER TABLE "camera_events"
  ADD CONSTRAINT "camera_events_incident_id_fkey"
  FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "camera_events_incident_id_idx" ON "camera_events"("incident_id") WHERE "incident_id" IS NOT NULL;
