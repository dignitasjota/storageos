-- Resolución del provider de cerradura POR DEVICE (multi-tenant con hardware
-- mixto): cada dispositivo puede declarar su provider ('stub'|'mqtt'|'http'|
-- 'dahua'). NULL = usar el default global de la env LOCK_PROVIDER (retrocompat).
ALTER TABLE "access_devices" ADD COLUMN "provider" TEXT;
