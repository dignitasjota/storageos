-- Fecha en que un tenant sale de la prueba (a pago, al plan Free o de baja).
-- La pone un disparador: hay muchos sitios que sacan a un tenant de `trial`
-- (pago por Stripe, pago manual, SEPA, Redsys, cambio de plan, fin de la prueba)
-- y así ninguno se olvida.
ALTER TABLE "tenants" ADD COLUMN "trial_ended_at" TIMESTAMPTZ(6);

CREATE OR REPLACE FUNCTION tenants_set_trial_ended_at() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'trial' AND NEW.status <> 'trial' AND NEW.trial_ended_at IS NULL THEN
    NEW.trial_ended_at := now();
  ELSIF NEW.status = 'trial' AND OLD.status <> 'trial' THEN
    -- Vuelve a la prueba (ampliación sobre una prueba vencida): cuenta de nuevo.
    NEW.trial_ended_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_trial_ended_at
  BEFORE UPDATE OF status ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION tenants_set_trial_ended_at();

-- Relleno aproximado de los que ya salieron: el fin de la prueba si se conoce;
-- si no, 30 días después del alta (sin pasar de hoy).
UPDATE "tenants"
SET "trial_ended_at" = LEAST(COALESCE("trial_ends_at", "created_at" + INTERVAL '30 days'), now())
WHERE "status" <> 'trial' AND "trial_ended_at" IS NULL;
