-- Suspensión de un add-on del tenant por impago (reversible): null = activo.
-- Suspendido → no cuenta al MRR ni a la capacidad, su feature se desactiva y sale
-- de la bandeja de cobros del «Hoy»; los datos ya creados NO se tocan.
ALTER TABLE "tenant_subscription_addons" ADD COLUMN "suspended_at" TIMESTAMPTZ(6);
