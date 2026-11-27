import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-tenants-review-2@storageos.local';
const SUPPORT_EMAIL = 'admin-tenants-review-2-support@storageos.local';
const DAY = 86_400_000;

/**
 * Tablas con `tenant_id` que anonimizar un tenant trata (borra o deja sin datos
 * personales). Una tabla nueva con `tenant_id` tiene que entrar aquí o en
 * `KEPT_ON_ANONYMIZE`, o este test falla.
 */
const TREATED_ON_ANONYMIZE = [
  'access_credentials',
  'access_devices',
  'access_logs',
  'ai_conversations',
  'ai_messages',
  'ai_pending_actions',
  'ai_scheduled_questions',
  'api_keys',
  'automation_runs',
  'bank_match_rules',
  'business_reminder_completions',
  'business_reminders',
  'camera_devices',
  'camera_events',
  'communications',
  'consents',
  'contract_annexes',
  'contract_inspection_photos',
  'contract_signatures',
  'contracts',
  'customer_authorized_persons',
  'customer_contacts',
  'customer_document_requests',
  'customer_documents',
  'customer_followups',
  'customer_interactions',
  'customer_messages',
  'customer_offers',
  'customers',
  'data_subject_requests',
  'delinquency_case_events',
  'delinquency_cases',
  'delinquency_pickup_requests',
  'email_suppressions',
  'email_verification_tokens',
  'expense_suppliers',
  'ga4_page_rows',
  'ga4_source_rows',
  'gocardless_settings',
  'google_ads_settings',
  'holded_settings',
  'incident_comments',
  'incidents',
  'invitations',
  'lead_activities',
  'lead_followups',
  'lead_visits',
  'leads',
  'legal_doc_acceptances',
  'meta_ads_settings',
  'notifications',
  'owner_statements',
  'owners',
  'password_reset_tokens',
  'payment_methods',
  'payment_plans',
  'platform_domain_checklists',
  'platform_domain_checks',
  'platform_email_logs',
  'platform_leads',
  'platform_legal_acceptances',
  'platform_nps_responses',
  'platform_redsys_cards',
  'platform_sepa_mandates',
  'push_subscriptions',
  'recovery_codes',
  'redsys_settings',
  'report_schedules',
  'reservations',
  'retention_offers',
  'reviews',
  'search_console_days',
  'search_console_devices',
  'search_console_rows',
  'seo_ai_actions',
  'seo_ai_conversations',
  'seo_ai_messages',
  'seo_ai_prompts',
  'seo_ai_sources',
  'seo_ai_visibility',
  'seo_alerts',
  'seo_annotation_dismissals',
  'seo_api_cache',
  'seo_api_requests',
  'seo_backlink_targets',
  'seo_cannibalizations',
  'seo_changes',
  'seo_competitors',
  'seo_content_briefs',
  'seo_conversions_daily',
  'seo_crawl_issues',
  'seo_crawl_pages',
  'seo_crawls',
  'seo_domain_keywords',
  'seo_domain_metrics',
  'seo_domain_opportunities',
  'seo_ga4_landing_daily',
  'seo_gsc_import_rows',
  'seo_gsc_imports',
  'seo_gsc_metrics',
  'seo_index_findings',
  'seo_keyword_groups',
  'seo_keyword_metrics',
  'seo_master_import_items',
  'seo_master_imports',
  'seo_opportunities',
  'seo_pagespeed_runs',
  'seo_project_domains',
  'seo_project_keywords',
  'seo_projects',
  'seo_provider_connections',
  'seo_reports',
  'seo_serp_results',
  'seo_sistrix_imports',
  'seo_sync_runs',
  'seo_sync_settings',
  'seo_tasks',
  'seo_tracked_keywords',
  'seo_url_inspections',
  'sepa_mandates',
  'sepa_settings',
  'sessions',
  'social_daily_metrics',
  'social_posts',
  'support_tickets',
  'task_comments',
  'tasks',
  'tenant_aeat_credentials',
  'tenant_data_exports',
  'tenant_email_domains',
  'tenant_ga4',
  'tenant_interactions',
  'tenant_search_console',
  'tenant_social_accounts',
  'tenant_stripe_accounts',
  'tenant_subscriptions',
  'tenant_whatsapp_settings',
  'unit_cessions',
  'unit_change_requests',
  'unit_requests',
  'user_passkeys',
  'users',
  'waitlist_entries',
  'web_chat_conversations',
  // Se borran con su conversación.
  'web_chat_messages',
  'webhook_deliveries',
  'webhooks',
  'whatsapp_conversations',
  'whatsapp_messages',
];

/** Tablas que se conservan a propósito al anonimizar (y por qué). */
const KEPT_ON_ANONYMIZE = [
  // Documentos fiscales y contables: se guardan por obligación legal.
  'bank_statement_transactions',
  'bank_statements',
  'cash_closures',
  'cash_movements',
  'contract_events',
  'coupon_redemptions',
  'dunning_actions',
  'expense_budgets',
  'expense_categories',
  'expenses',
  'fiscal_period_closures',
  'invoice_items',
  'invoice_refunds',
  'invoice_series',
  'invoices',
  'payments',
  'platform_coupon_redemptions',
  'platform_domain_cleanups',
  'platform_dunning_events',
  'platform_invoices',
  'platform_redsys_orders',
  'platform_sepa_remittance_items',
  'recurring_expenses',
  'redsys_orders',
  'rent_increase_items',
  'rent_increases',
  'sepa_remittance_items',
  'sepa_remittances',
  'tenant_subscription_payments',
  'verifactu_emitters',
  'verifactu_records',
  'verifactu_submissions',
  // Inventario y configuración del negocio, sin datos de personas.
  'automation_rules',
  'blog_posts',
  'campaign_automations',
  'campaign_segments',
  'campaign_templates',
  'campaigns',
  'competitor_facilities',
  'competitor_promotions',
  'competitor_unit_observations',
  'competitor_units',
  'coupons',
  'customer_canned_responses',
  'customer_saved_views',
  'facilities',
  'facility_documents',
  'facility_slug_redirects',
  'faq_entries',
  'insurance_plans',
  'invoice_saved_views',
  'legal_doc_versions',
  'maintenance_plans',
  'marketing_annotations',
  'marketing_channels',
  'message_templates',
  'pricing_rules',
  'product_sale_items',
  'product_sales',
  'product_stock',
  'product_stock_movements',
  'products',
  'promo_landings',
  'promotions',
  'tenant_roles',
  'unit_price_history',
  'unit_saved_views',
  'unit_status_history',
  'unit_tenancies',
  'unit_types',
  'units',
  'web_area_pages',
  'web_slug_redirects',
  // Cifras y métricas sin datos personales.
  'ad_conversion_uploads',
  'ad_metrics_daily',
  'ai_usage_events',
  'campaign_clicks',
  'campaign_links',
  'customer_interest_events',
  'feature_interest_events',
  'mrr_snapshots',
  'promo_landing_visits',
  'tenant_activity_days',
  'tenant_health_daily',
  'tenant_health_snapshots',
  'tenant_storage_usage',
  'tenant_storage_usage_history',
  'web_events',
  'web_page_daily',
  'web_visits',
  // Solo enlazan fichas que ya se anonimizan (ids y estados).
  'access_credential_sync',
  'customer_conversations',
  'customer_message_reads',
  'delinquency_case_files',
  'lead_quotes',
  'notification_reads',
  'opportunity_dismissals',
  'product_update_reactions',
  'referrals',
  'report_runs',
  'support_ticket_reads',
  'support_ticket_watchers',
  'tenant_platform_message_reads',
  'today_snoozes',
  'user_facilities',
  'winback_sends',
  // Registro de la plataforma y del soporte (auditoría, suscripción, ventas).
  'admin_approval_requests',
  'audit_logs',
  'business_reminder_notices',
  'campaign_automation_sends',
  'impersonation_logs',
  // Propuestas de extras y candidatos descartados (Oportunidades).
  'platform_addon_offers',
  'platform_opportunity_dismissals',
  'platform_quote_offers',
  'sales_addon_claims',
  'sales_assignments',
  'sales_commission_items',
  // Archivos y recuperaciones de comerciales: ids, motivo y fechas (comisiones).
  'sales_recoveries',
  'sales_wins',
  'tenant_addon_trials',
  'tenant_feature_overrides',
  'tenant_followups',
  'tenant_lifecycle_emails',
  'tenant_platform_messages',
  'tenant_subscription_addons',
];

/** Arreglos de la segunda revisión del apartado Tenants del panel admin. */
describe('Admin: arreglos del apartado Tenants (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  let supportToken: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    const passwordHash = await argonHash('AdminTest!23');
    await db.superAdmin.create({
      data: { email: ADMIN_EMAIL, passwordHash, fullName: 'Admin Revisión', role: 'superadmin' },
    });
    await db.superAdmin.create({
      data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Revisión', role: 'support' },
    });
    app = await createTestApp();
    token = (
      await http().post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: 'AdminTest!23' })
    ).body.accessToken as string;
    supportToken = (
      await http()
        .post('/admin/auth/login')
        .send({ email: SUPPORT_EMAIL, password: 'AdminTest!23' })
    ).body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  /** Pasa la suscripción de una prueba al plan de pago, activa. */
  async function toPaying(tenantId: string) {
    await db.tenant.update({
      where: { id: tenantId },
      data: { status: 'active', trialEndsAt: null },
    });
    await db.tenantSubscription.update({ where: { tenantId }, data: { status: 'active' } });
  }

  it('quitar la exención empieza el periodo hoy, sin deuda de los meses exentos', async () => {
    const t = await registerVerifiedUser(app, 'rev2exempt');
    await toPaying(t.tenantId);
    await http()
      .post(`/admin/tenants/${t.tenantId}/billing-exempt`)
      .set(admin())
      .send({ exempt: true })
      .expect(200);
    // Lleva meses exento: su periodo quedó atrás.
    await db.tenantSubscription.update({
      where: { tenantId: t.tenantId },
      data: {
        currentPeriodStart: new Date(Date.now() - 200 * DAY),
        currentPeriodEnd: new Date(Date.now() - 170 * DAY),
      },
    });
    await http()
      .post(`/admin/tenants/${t.tenantId}/billing-exempt`)
      .set(admin())
      .send({ exempt: false })
      .expect(200);
    const sub = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } });
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodStart.getTime()).toBeGreaterThan(Date.now() - DAY);
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);

    const overview = await http().get('/admin/tenants-overview').set(admin()).expect(200);
    const row = (overview.body as { id: string; overdueSince: string | null }[]).find(
      (r) => r.id === t.tenantId,
    );
    expect(row?.overdueSince).toBeNull();
  });

  it('pasar a manual conserva la prueba y, con un impago de Stripe, vuelve al periodo debido', async () => {
    const trial = await registerVerifiedUser(app, 'rev2manualtrial');
    await db.tenantSubscription.update({
      where: { tenantId: trial.tenantId },
      data: { billingMode: 'stripe', stripeSubscriptionId: `sub_t_${trial.tenantId}` },
    });
    await http().post(`/admin/tenants/${trial.tenantId}/switch-to-manual`).set(admin()).expect(200);
    const trialSub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: trial.tenantId },
    });
    expect(trialSub.status).toBe('trial');
    expect(trialSub.billingMode).toBe('manual');

    const debtor = await registerVerifiedUser(app, 'rev2manualdue');
    await toPaying(debtor.tenantId);
    const start = new Date(Date.now() - 10 * DAY);
    await db.tenantSubscription.update({
      where: { tenantId: debtor.tenantId },
      data: {
        billingMode: 'stripe',
        stripeSubscriptionId: `sub_d_${debtor.tenantId}`,
        status: 'past_due',
        currentPeriodStart: start,
        currentPeriodEnd: new Date(Date.now() + 20 * DAY),
        manualExtensionDays: 0,
      },
    });
    // «Debe desde» en la lista: el inicio del periodo del cobro que falló.
    const overview = await http().get('/admin/tenants-overview').set(admin()).expect(200);
    const row = (overview.body as { id: string; overdueSince: string | null }[]).find(
      (r) => r.id === debtor.tenantId,
    );
    expect(row?.overdueSince).toBe(start.toISOString());

    await http()
      .post(`/admin/tenants/${debtor.tenantId}/switch-to-manual`)
      .set(admin())
      .expect(200);
    const sub = await db.tenantSubscription.findUniqueOrThrow({
      where: { tenantId: debtor.tenantId },
    });
    expect(sub.status).toBe('past_due');
    expect(sub.currentPeriodEnd.toISOString()).toBe(start.toISOString());
  });

  it('ampliar la prueba mueve el fin del periodo y reactivar con la prueba vencida la deja en solo lectura', async () => {
    const t = await registerVerifiedUser(app, 'rev2trial');
    await http()
      .post(`/admin/tenants/${t.tenantId}/extend-trial`)
      .set(admin())
      .send({ days: 10, reason: 'más tiempo' })
      .expect(200);
    const [tenant, sub] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } }),
      db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } }),
    ]);
    expect(sub.currentPeriodEnd.toISOString()).toBe(tenant.trialEndsAt?.toISOString());

    // Suspendido con la prueba ya vencida.
    await db.tenant.update({
      where: { id: t.tenantId },
      data: { status: 'suspended', trialEndsAt: new Date(Date.now() - DAY) },
    });
    await http()
      .post(`/admin/tenants/${t.tenantId}/reactivate`)
      .set(admin())
      .send({ reason: 'vuelve' })
      .expect(200);
    const [after, afterSub] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } }),
      db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } }),
    ]);
    expect(after.status).toBe('active');
    expect(after.trialEndsAt).toBeNull();
    expect(afterSub.status).toBe('expired');
  });

  it('aprobar un cambio de funciones no borra las cortesías que ya tenía', async () => {
    const t = await registerVerifiedUser(app, 'rev2features');
    const until = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    await http()
      .put(`/admin/tenants/${t.tenantId}/features`)
      .set(admin())
      .send({ overrides: [{ feature: 'ai_assistant', enabled: true, expiresAt: until }] })
      .expect(200);
    const created = await http()
      .post('/admin/approvals')
      .set({ Authorization: `Bearer ${supportToken}` })
      .send({
        tenantId: t.tenantId,
        reason: 'Lo ha pedido el cliente',
        request: {
          action: 'set_features',
          payload: { overrides: [{ feature: 'sepa', enabled: true }] },
        },
      })
      .expect(201);
    await http()
      .post(`/admin/approvals/${created.body.id}/approve`)
      .set(admin())
      .send({})
      .expect(200);
    const overrides = await db.tenantFeatureOverride.findMany({ where: { tenantId: t.tenantId } });
    const ai = overrides.find((o) => o.feature === 'ai_assistant');
    expect(ai?.enabled).toBe(true);
    expect(ai?.expiresAt).not.toBeNull();
    expect(overrides.some((o) => o.feature === 'sepa' && o.enabled)).toBe(true);
  });

  it('el vaciado de datos se bloquea si ya ha pagado cuotas', async () => {
    const t = await registerVerifiedUser(app, 'rev2reset');
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: t.tenantId,
        provider: 'bank_transfer',
        status: 'paid',
        amount: 59,
        currency: 'EUR',
        paidAt: new Date(),
      },
    });
    const preview = await http()
      .get(`/admin/tenants/${t.tenantId}/reset-preview`)
      .set(admin())
      .expect(200);
    expect(
      (preview.body.blockers as { code: string }[]).some((b) => b.code === 'paid_subscription'),
    ).toBe(true);
    expect(preview.body.issuedInvoices).toBe(0);
    const res = await http()
      .post(`/admin/tenants/${t.tenantId}/reset-operational-data`)
      .set(admin())
      .send({ confirmSlug: t.slug, reason: 'datos de prueba', exported: true })
      .expect(409);
    expect(res.body.code).toBe('tenant_reset_blocked');
  });

  it('anonimizar da de baja el mandato SEPA y borra los secretos y el dominio', async () => {
    const t = await registerVerifiedUser(app, 'rev2anon');
    await db.platformSepaMandate.create({
      data: {
        tenantId: t.tenantId,
        reference: `REV2-${t.tenantId.slice(0, 8)}`,
        ibanEncrypted: 'cifrado',
        ibanLast4: '1332',
        signedAt: new Date(),
        sequenceType: 'FRST',
        status: 'active',
        signatureStatus: 'signed',
        debtorName: 'Ana García',
        typedSignature: 'Ana García',
      },
    });
    const domain = `rev2-${t.tenantId.slice(0, 8)}.example.com`;
    await db.tenant.update({
      where: { id: t.tenantId },
      data: {
        aiOwnApiKeyEncrypted: 'clave',
        customDomain: domain,
        strategicNotes: 'Llamar a Ana al 600000000',
      },
    });
    await http()
      .post(`/admin/tenants/${t.tenantId}/anonymize`)
      .set(admin())
      .send({ reason: 'baja RGPD', exported: true })
      .expect(200);
    const [mandate, tenant, sub] = await Promise.all([
      db.platformSepaMandate.findFirstOrThrow({ where: { tenantId: t.tenantId } }),
      db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } }),
      db.tenantSubscription.findUniqueOrThrow({ where: { tenantId: t.tenantId } }),
    ]);
    expect(mandate.status).toBe('cancelled');
    expect(mandate.ibanEncrypted).toBe('');
    expect(mandate.typedSignature).toBeNull();
    expect(tenant.aiOwnApiKeyEncrypted).toBeNull();
    expect(tenant.customDomain).toBeNull();
    expect(tenant.strategicNotes).toBeNull();
    // Ya no se cobra (sin Stripe y en manual); el estado de la suscripción se
    // conserva para que la baja siga contando en las métricas.
    expect(sub.stripeSubscriptionId).toBeNull();
    expect(sub.billingMode).toBe('manual');
    expect(tenant.status).toBe('cancelled');
  });

  it('toda tabla con tenant_id está tratada o conservada a propósito al anonimizar', async () => {
    const rows = await db.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name::text AS table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`;
    const known = new Set([...TREATED_ON_ANONYMIZE, ...KEPT_ON_ANONYMIZE]);
    const missing = rows.map((r) => r.table_name).filter((name) => !known.has(name));
    expect(missing).toEqual([]);
    // Ninguna en las dos listas a la vez.
    expect(TREATED_ON_ANONYMIZE.filter((n) => KEPT_ON_ANONYMIZE.includes(n))).toEqual([]);
  });

  it('una sesión de soporte con cambios no crea claves de API ni traspasa la propiedad', async () => {
    const t = await registerVerifiedUser(app, 'rev2imp');
    const imp = await http()
      .post(`/admin/tenants/${t.tenantId}/impersonate`)
      .set(admin())
      .send({ reason: 'revisar', readOnly: false })
      .expect(200);
    const auth = { Authorization: `Bearer ${imp.body.accessToken as string}` };
    const key = await http()
      .post('/settings/api-keys')
      .set(auth)
      .send({ name: 'Clave del soporte' })
      .expect(403);
    expect(key.body.code).toBe('not_allowed_while_impersonating');
    const owner = await http()
      .post(`/users/${t.userId}/transfer-ownership`)
      .set(auth)
      .send({})
      .expect(403);
    expect(owner.body.code).toBe('not_allowed_while_impersonating');
  });

  it('una sesión de soporte en solo lectura ve lo que ve el propietario (Suscripción)', async () => {
    const t = await registerVerifiedUser(app, 'rev2ro');
    const imp = await http()
      .post(`/admin/tenants/${t.tenantId}/impersonate`)
      .set(admin())
      .send({ reason: 'mirar la suscripción' })
      .expect(200);
    const auth = { Authorization: `Bearer ${imp.body.accessToken as string}` };
    await http().get('/settings/saas-billing').set(auth).expect(200);
    // Y sigue sin poder escribir.
    const write = await http().post('/settings/api-keys').set(auth).send({ name: 'x' }).expect(403);
    expect(['not_allowed_while_impersonating', 'impersonation_read_only']).toContain(
      write.body.code,
    );
  });

  it('cerrar las sesiones de un usuario corta también su acceso en curso', async () => {
    const t = await registerVerifiedUser(app, 'rev2tokens');
    // El token se compara en segundos: que el cierre caiga en otro segundo.
    await new Promise((r) => setTimeout(r, 1100));
    await http()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${t.accessToken}` })
      .expect(200);
    await http()
      .post(`/admin/tenants/${t.tenantId}/users/${t.userId}/revoke-sessions`)
      .set(admin())
      .expect(200);
    const res = await http()
      .get('/auth/me')
      .set({ Authorization: `Bearer ${t.accessToken}` })
      .expect(401);
    expect(res.body.code).toBe('session_revoked');
  });

  it('el rol soporte ve el documento de los inquilinos enmascarado', async () => {
    const t = await registerVerifiedUser(app, 'rev2dni');
    await createCustomer(app, t.accessToken, { documentNumber: '12345678Z' });
    const asSupport = await http()
      .get(`/admin/tenants/${t.tenantId}/customers`)
      .set({ Authorization: `Bearer ${supportToken}` })
      .expect(200);
    expect(asSupport.body[0].documentNumber).toBe('***678Z');
    const asAdmin = await http()
      .get(`/admin/tenants/${t.tenantId}/customers`)
      .set(admin())
      .expect(200);
    expect(asAdmin.body[0].documentNumber).toBe('12345678Z');
  });

  it('el alta manual envía un enlace de 7 días para elegir la contraseña', async () => {
    const stamp = Date.now().toString(36);
    const res = await http()
      .post('/admin/tenants')
      .set(admin())
      .send({
        tenantName: `Trasteros Rev2 ${stamp}`,
        tenantSlug: `test-rev2-${stamp}`,
        ownerName: 'Ana García',
        ownerEmail: `test-rev2-${stamp}@storageos.local`,
        planSlug: 'starter',
        trialDays: 30,
      })
      .expect(201);
    expect(res.body.emailSent).toBe(true);
    const token = await db.passwordResetToken.findFirstOrThrow({
      where: { tenantId: res.body.tenantId as string, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
  });
});
