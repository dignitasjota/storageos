-- Push para el equipo del tenant (PWA del panel): una suscripción es de un
-- inquilino (portal) o de un usuario del equipo (panel), nunca de los dos.
ALTER TABLE "push_subscriptions" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "push_subscriptions" ADD COLUMN "user_id" UUID;
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "push_subscriptions"
  ADD CONSTRAINT "push_subscriptions_owner_check" CHECK (("customer_id" IS NULL) <> ("user_id" IS NULL));
CREATE INDEX "push_subscriptions_tenant_id_user_id_idx" ON "push_subscriptions" ("tenant_id", "user_id");
