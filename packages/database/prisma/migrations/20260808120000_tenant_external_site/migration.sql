-- Web «externa»: URL donde el tenant ya aloja su propia web (proxy inverso,
-- nunca almacenamos su contenido). Nullable = sin configurar.
ALTER TABLE "tenants" ADD COLUMN "external_site_url" TEXT;
