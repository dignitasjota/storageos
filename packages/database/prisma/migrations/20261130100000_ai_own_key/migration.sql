-- Asistente IA del panel: clave propia del tenant (como en WhatsApp).

-- platform = la IA de la plataforma con su límite (y la clave propia, si la
-- tiene, al gastar las consultas del mes); own = siempre su clave.
ALTER TABLE "tenants"
  ADD COLUMN "ai_mode" TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN "ai_own_api_key_encrypted" TEXT,
  ADD COLUMN "ai_own_model" TEXT;

-- Consultas hechas con la clave propia: no cuentan para el límite ni para el
-- coste de la plataforma.
ALTER TABLE "ai_usage_events" ADD COLUMN "own_key" BOOLEAN NOT NULL DEFAULT false;
