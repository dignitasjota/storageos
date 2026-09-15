import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-platform-sepa-remittances-test@storageos.local';

/**
 * Fase 2: la remesa SEPA de plataforma cobra de verdad. Preview → crear →
 * doble-creación-mismo-periodo-rechazada → confirmar → verifica el pago
 * registrado (reutilizando `recordManualPayment`) + periodo extendido +
 * mandato rotado FRST→RCUR.
 */
describe('Platform SEPA — remesas (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superAdminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    // Singleton global: aislar de lo que haya dejado otro spec.
    await adminClient.platformSepaSettings.deleteMany({});
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Platform SEPA Remittances Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login falló: ${login.status} ${JSON.stringify(login.body)}`);
    }
    superAdminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.platformSepaSettings.deleteMany({});
    await adminClient.$disconnect();
    await app.close();
    await cleanupTestTenants();
  });

  const adminAuth = () => ({ Authorization: `Bearer ${superAdminToken}` });

  /**
   * Da de alta un tenant en modo `sepa` con mandato activo y periodo a punto
   * de vencer. El tenant nace en el plan `starter` (79€/mes, seed) — no se
   * muta el precio del plan (es una fila global compartida por todos los
   * specs en `--runInBand`).
   */
  async function setupSepaTenant(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await request(app.getHttpServer())
      .post('/settings/saas-billing/sepa-mandate')
      .set(auth)
      .send({ iban: 'ES9121000418450200051332', signedAt: '2026-09-01' });
    const toSepa = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/billing-mode`)
      .set(adminAuth())
      .send({ mode: 'sepa' });
    if (toSepa.status !== 200) {
      throw new Error(`billing-mode a sepa falló: ${JSON.stringify(toSepa.body)}`);
    }
    // Periodo a 2 días vista (dentro del margen de 5 días).
    const periodEnd = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    await adminClient.tenantSubscription.update({
      where: { tenantId: owner.tenantId },
      data: { currentPeriodEnd: periodEnd, status: 'active' },
    });
    return { owner, periodEnd };
  }

  it('sin acreedor configurado → 400 al crear remesa', async () => {
    await setupSepaTenant('sepa-rem-noconf');
    const create = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances')
      .set(adminAuth())
      .send({ name: 'Remesa test', collectionDate: '2026-09-25' });
    expect(create.status).toBe(400);
    expect(create.body.code).toBe('sepa_not_configured');
  });

  it('preview → crea remesa → doble creación del mismo periodo la excluye → confirma → pago registrado + periodo extendido + FRST→RCUR', async () => {
    // Configura y activa el acreedor de plataforma.
    const settings = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({
        creditorName: 'TrasterOS SL',
        creditorId: 'ES12ZZZ12345678',
        creditorIban: 'ES9121000418450200051332',
        creditorBic: 'BBVAESMMXXX',
        enabled: true,
      });
    expect(settings.status).toBe(200);

    const { owner, periodEnd } = await setupSepaTenant('sepa-rem-flow');

    // Preview: el tenant aparece elegible.
    const preview = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances/preview')
      .set(adminAuth());
    expect(preview.status).toBe(200);
    const eligibleRow = preview.body.eligible.find(
      (e: { tenantId: string }) => e.tenantId === owner.tenantId,
    );
    expect(eligibleRow).toBeTruthy();
    expect(eligibleRow.amount).toBe(79);

    // Crea la remesa incluyendo solo a este tenant.
    const created = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances')
      .set(adminAuth())
      .send({
        name: 'Remesa septiembre',
        collectionDate: '2026-09-25',
        tenantIds: [owner.tenantId],
      });
    expect(created.status).toBe(201);
    expect(created.body.itemCount).toBe(1);
    expect(created.body.total).toBe(79);
    expect(created.body.status).toBe('generated');

    // El XML pain.008 se generó y contiene al deudor.
    const xml = await request(app.getHttpServer())
      .get(`/admin/platform-sepa/remittances/${created.body.id}/xml`)
      .set(adminAuth());
    expect(xml.status).toBe(200);
    expect(xml.body.xml).toContain('pain.008.001.02');
    expect(xml.body.xml).toContain('ES9121000418450200051332');
    expect(xml.body.xml).toContain('FRST');

    // Detalle con items.
    const detail = await request(app.getHttpServer())
      .get(`/admin/platform-sepa/remittances/${created.body.id}`)
      .set(adminAuth());
    expect(detail.status).toBe(200);
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0].tenantId).toBe(owner.tenantId);
    expect(detail.body.items[0].itemStatus).toBe('pending');

    // Segunda remesa para el MISMO tenant+periodo → lo excluye (ya tiene un
    // item pending) → sin más tenants elegibles → 400.
    const dup = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances')
      .set(adminAuth())
      .send({
        name: 'Remesa duplicada',
        collectionDate: '2026-09-26',
        tenantIds: [owner.tenantId],
      });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('no_eligible_tenants');

    // Confirma el cobro: reutiliza recordManualPayment (extiende periodo +
    // registra el pago) y rota el mandato FRST→RCUR.
    const confirm = await request(app.getHttpServer())
      .post(`/admin/platform-sepa/remittances/${created.body.id}/confirm`)
      .set(adminAuth());
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe('confirmed');

    const sub = await adminClient.tenantSubscription.findUnique({
      where: { tenantId: owner.tenantId },
    });
    expect(sub!.currentPeriodEnd.getTime()).toBeGreaterThan(periodEnd.getTime());
    expect(sub!.status).toBe('active');

    const payment = await adminClient.tenantSubscriptionPayment.findFirst({
      where: { tenantId: owner.tenantId, provider: 'sepa' },
    });
    expect(payment).toBeTruthy();
    expect(Number(payment!.amount)).toBe(79);

    const mandate = await adminClient.platformSepaMandate.findFirst({
      where: { tenantId: owner.tenantId, status: 'active' },
    });
    expect(mandate!.sequenceType).toBe('RCUR');

    const item = await adminClient.platformSepaRemittanceItem.findFirst({
      where: { tenantId: owner.tenantId },
    });
    expect(item!.itemStatus).toBe('collected');

    // Ahora que el item confirmado está `collected`, una tercera remesa para
    // el MISMO periodo sigue excluyéndolo (no doble cobro tras confirmar).
    const afterConfirmDup = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances/preview')
      .set(adminAuth());
    const stillThere = afterConfirmDup.body.eligible.find(
      (e: { tenantId: string }) => e.tenantId === owner.tenantId,
    );
    expect(stillThere).toBeUndefined();

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer()).get('/admin/platform-sepa/remittances');
    expect(noAuth.status).toBe(401);
  });

  it('excluye del importe un add-on ya cobrado por Stripe (evita el doble cobro)', async () => {
    const settings = await request(app.getHttpServer())
      .put('/admin/platform-sepa/settings')
      .set(adminAuth())
      .send({ creditorName: 'TrasterOS SL', creditorId: 'ES12ZZZ12345678', enabled: true });
    expect(settings.status).toBe(200);

    const { owner } = await setupSepaTenant('sepa-rem-addon');

    // Contrata un add-on del catálogo y lo pone en modo Stripe A MANO (sin
    // pasar por el endpoint real, que llamaría a Stripe) para simular un
    // add-on que ya se cobra por su propio subscription item.
    const addon = await adminClient.subscriptionAddon.findFirst({ where: { isActive: true } });
    if (!addon) throw new Error('no hay add-ons activos en el catálogo de seed');
    await adminClient.tenantSubscriptionAddon.create({
      data: {
        tenantId: owner.tenantId,
        addonId: addon.id,
        priceMonthly: 15,
        quantity: 1,
        billingMode: 'stripe',
      },
    });

    const preview = await request(app.getHttpServer())
      .post('/admin/platform-sepa/remittances/preview')
      .set(adminAuth());
    const row = preview.body.eligible.find(
      (e: { tenantId: string }) => e.tenantId === owner.tenantId,
    );
    expect(row).toBeTruthy();
    // Solo el plan (79), NO +15 del add-on en modo Stripe.
    expect(row.amount).toBe(79);
  });
});
