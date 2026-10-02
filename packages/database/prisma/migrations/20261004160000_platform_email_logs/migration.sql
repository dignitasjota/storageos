-- Historial de los correos que manda la plataforma (no los de un tenant a sus
-- inquilinos, que ya quedan en `communications`): verificación, contraseña,
-- invitaciones, bienvenida, facturas y avisos de pago de la suscripción,
-- emails del admin, avisos al equipo e informe mensual. Antes no quedaba
-- rastro de nada de esto: ante un «no me ha llegado» no había dónde mirar.
--
-- No guarda el cuerpo de los correos de cuenta (llevan enlaces que dan acceso).
CREATE TABLE "platform_email_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body_text" TEXT,
  "kind" TEXT,
  "category" TEXT,
  "status" TEXT NOT NULL,
  "provider" TEXT,
  "provider_message_id" TEXT,
  "error_message" TEXT,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_email_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_email_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "platform_email_logs_created_at_idx" ON "platform_email_logs" ("created_at" DESC, "id" DESC);
CREATE INDEX "platform_email_logs_tenant_id_idx" ON "platform_email_logs" ("tenant_id", "created_at" DESC);
CREATE INDEX "platform_email_logs_provider_message_id_idx" ON "platform_email_logs" ("provider_message_id");

-- Tabla global: el rol restringido de la app no la necesita (va por el rol admin).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storageos_app') THEN
    REVOKE ALL ON TABLE "platform_email_logs" FROM storageos_app;
  END IF;
END $$;
