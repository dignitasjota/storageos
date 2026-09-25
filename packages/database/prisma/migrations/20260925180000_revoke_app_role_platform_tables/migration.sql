-- Defensa en profundidad: el rol restringido de la app (`storageos_app`, el de
-- DATABASE_URL, sometido a RLS) no necesita las tablas GLOBALES de plataforma.
-- Todo su acceso va por el rol admin (`PrismaAdminService`). Sin RLS (no tienen
-- tenant, o son de la relación plataforma↔tenant), si una consulta del día a día
-- las tocara por error vería datos de TODOS los tenants o del super admin
-- (hashes de sesión y 2FA, IBAN del acreedor SEPA, cupones, auditoría…).
--
-- Se conservan `subscription_plans` y `subscription_addons`: consultas del
-- tenant (/auth/me, FeatureGuard) los leen con `include: { plan: true }`.
--
-- ⚠️ `ALTER DEFAULT PRIVILEGES` (fase 1A) concede SELECT/INSERT/UPDATE/DELETE a
-- `storageos_app` en cada tabla NUEVA: una tabla global nueva debe añadir su
-- propio REVOKE (o RLS) en su migración.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storageos_app') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'cron_runs',
    'impersonation_logs',
    'mrr_snapshots',
    'platform_alert_settings',
    'platform_banner',
    'platform_billing_settings',
    'platform_coupons',
    'platform_dunning_events',
    'platform_dunning_settings',
    'platform_invoice_lines',
    'platform_invoices',
    'platform_legal_documents',
    'platform_sepa_mandates',
    'platform_sepa_remittance_items',
    'platform_sepa_remittances',
    'platform_sepa_settings',
    'processed_gocardless_events',
    'processed_stripe_events',
    'security_events',
    'super_admin_audit_logs',
    'super_admin_notifications',
    'super_admin_recovery_codes',
    'super_admin_sessions',
    'super_admins',
    'tenant_followups',
    'tenant_lifecycle_emails'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE %I FROM storageos_app', t);
    END IF;
  END LOOP;
END
$$;
