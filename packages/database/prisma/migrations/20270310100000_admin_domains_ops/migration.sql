-- Dominios propios: comprobaciones completas, guía de activación con casillas,
-- limpieza del Proxy Host y ajuste de avisos al tenant. Todas globales.

-- Cada comprobación completa de un dominio (DNS, https y certificado).
CREATE TABLE "platform_domain_checks" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ok" BOOLEAN NOT NULL,
  "dns_ok" BOOLEAN NOT NULL,
  "www_ok" BOOLEAN,
  "https_ok" BOOLEAN NOT NULL,
  "https_status" INTEGER,
  "https_ms" INTEGER,
  "https_error" TEXT,
  "tls_valid" BOOLEAN NOT NULL,
  "tls_valid_to" TIMESTAMPTZ(6),
  "tls_error" TEXT,
  "detail" JSONB,
  CONSTRAINT "platform_domain_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_domain_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "platform_domain_checks_tenant_idx"
  ON "platform_domain_checks"("tenant_id", "checked_at" DESC);
REVOKE ALL ON "platform_domain_checks" FROM storageos_app;

-- Pasos de la guía de activación ya hechos, por tenant.
CREATE TABLE "platform_domain_checklists" (
  "tenant_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "steps" JSONB NOT NULL DEFAULT '{}',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by_id" UUID,
  CONSTRAINT "platform_domain_checklists_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "platform_domain_checklists_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
REVOKE ALL ON "platform_domain_checklists" FROM storageos_app;

-- Proxy Hosts de NPM que hay que borrar porque el tenant cambió o quitó su dominio.
CREATE TABLE "platform_domain_cleanups" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "tenant_id" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "done_at" TIMESTAMPTZ(6),
  "done_by_id" UUID,
  CONSTRAINT "platform_domain_cleanups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_domain_cleanups_tenant_id_fkey" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "platform_domain_cleanups_open_idx"
  ON "platform_domain_cleanups"("done_at", "created_at" DESC);
REVOKE ALL ON "platform_domain_cleanups" FROM storageos_app;

-- Ajustes globales de los dominios propios (un único registro).
CREATE TABLE "platform_domain_settings" (
  "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
  "notify_tenant_enabled" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "platform_domain_settings_pkey" PRIMARY KEY ("id")
);
REVOKE ALL ON "platform_domain_settings" FROM storageos_app;
