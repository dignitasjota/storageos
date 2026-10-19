-- Funciones activadas a mano con caducidad (cortesías) y pruebas gratis de un extra.
ALTER TABLE "tenant_feature_overrides"
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "trial_addon_id" UUID,
  ADD COLUMN "expiry_notified_at" TIMESTAMPTZ(6);

ALTER TABLE "tenant_feature_overrides"
  ADD CONSTRAINT "tenant_feature_overrides_trial_addon_id_fkey"
  FOREIGN KEY ("trial_addon_id") REFERENCES "subscription_addons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "tenant_feature_overrides_expires_at_idx" ON "tenant_feature_overrides" ("expires_at");
