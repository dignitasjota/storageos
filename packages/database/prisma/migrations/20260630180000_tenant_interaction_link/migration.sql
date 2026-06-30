-- Enlace opcional asociado a una interacción (p. ej. al ticket de soporte que la originó).
ALTER TABLE "tenant_interactions" ADD COLUMN "link" TEXT;
