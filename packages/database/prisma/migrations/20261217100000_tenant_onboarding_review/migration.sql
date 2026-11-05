-- Constancia de la aceptación de los términos al registrarse.
ALTER TABLE "users"
  ADD COLUMN "terms_accepted_at" TIMESTAMPTZ(6),
  ADD COLUMN "terms_accepted_hash" TEXT,
  ADD COLUMN "terms_accepted_ip" TEXT,
  ADD COLUMN "terms_accepted_user_agent" TEXT;

-- Puesta en marcha: pasos que el tenant ha marcado como «no aplica».
ALTER TABLE "tenants" ADD COLUMN "onboarding_state" JSONB NOT NULL DEFAULT '{}';
