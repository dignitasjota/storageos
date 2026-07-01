-- Dunning del SaaS: cobro automático de tenants morosos (recordatorios escalados
-- + suspensión). Config singleton + registro de acciones (idempotencia por ciclo
-- de impago, identificado por period_end).

CREATE TABLE "platform_dunning_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reminder1_days" INTEGER NOT NULL DEFAULT 3,
    "reminder2_days" INTEGER NOT NULL DEFAULT 10,
    "suspend_days" INTEGER NOT NULL DEFAULT 21,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_dunning_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_dunning_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "tenant_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "platform_dunning_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_dunning_events_unique" ON "platform_dunning_events" ("tenant_id", "step", "period_end");
CREATE INDEX "platform_dunning_events_tenant_idx" ON "platform_dunning_events" ("tenant_id");
ALTER TABLE "platform_dunning_events" ADD CONSTRAINT "platform_dunning_events_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
