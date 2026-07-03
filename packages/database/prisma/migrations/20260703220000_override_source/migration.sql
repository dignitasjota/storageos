-- Origen del override de feature: 'manual' = cortesía del super admin (no se
-- retira al quitar/suspender un add-on) · 'addon' = activado por un add-on (se
-- retira solo cuando ningún add-on activo del tenant sostiene ya esa feature).
-- Los existentes se marcan 'manual' (lado conservador: no romper accesos).
ALTER TABLE "tenant_feature_overrides" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
