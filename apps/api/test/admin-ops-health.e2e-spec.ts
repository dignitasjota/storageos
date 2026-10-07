import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { AeatCertExpiryService } from '../src/modules/admin/aeat-cert-expiry.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-ops-test@storageos.local';
const DAY = 86_400_000;

describe('Salud operativa del super admin (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Ops',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('las tareas programadas quedan registradas y avisa de las atrasadas', async () => {
    // El registro se hace al arrancar (asíncrono): esperamos a que aparezca.
    let crons: { name: string; overdue: boolean; nextRunAt: string | null }[] = [];
    for (let i = 0; i < 20 && !crons.some((c) => c.name === 'dunning.daily'); i++) {
      crons = (await request(app.getHttpServer()).get('/admin/crons').set(adminAuth)).body;
      await new Promise((r) => setTimeout(r, 250));
    }
    const dunning = crons.find((c) => c.name === 'dunning.daily');
    expect(dunning).toBeTruthy();
    expect(dunning!.overdue).toBe(false);
    expect(dunning!.nextRunAt).toBeTruthy();

    // Una tarea cuya ejecución prevista pasó hace una hora → atrasada, también en «Hoy».
    await admin.cronHeartbeat.upsert({
      where: { name: 'e2e.stuck' },
      create: {
        name: 'e2e.stuck',
        process: 'worker',
        expression: '0 6 * * *',
        nextRunAt: new Date(Date.now() - 3_600_000),
      },
      update: { nextRunAt: new Date(Date.now() - 3_600_000) },
    });
    const after = await request(app.getHttpServer()).get('/admin/crons').set(adminAuth);
    expect(after.body.find((c: { name: string }) => c.name === 'e2e.stuck').overdue).toBe(true);
    const today = await request(app.getHttpServer()).get('/admin/today').set(adminAuth);
    expect(today.body.overdueCrons.some((c: { name: string }) => c.name === 'e2e.stuck')).toBe(
      true,
    );
    await admin.cronHeartbeat.delete({ where: { name: 'e2e.stuck' } });
  });

  it('facturas rechazadas por la AEAT y certificados a punto de caducar', async () => {
    const owner = await registerVerifiedUser(app, 'opshealth');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, { email: 'ops@e2e.local' });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set(tenantAuth)
      .expect(200);
    const inv = await admin.invoice.update({
      where: { id: invoiceId },
      data: {
        aeatStatus: 'rejected',
        aeatResponse: { message: 'NIF del destinatario no censado' },
      },
      select: { tenantId: true },
    });

    // Certificado que caduca en 10 días (el aviso de 15 días toca hoy).
    const ownerUser = await admin.user.findFirstOrThrow({
      where: { tenantId: inv.tenantId, role: 'owner' },
      select: { id: true },
    });
    await admin.tenantAeatCredential.create({
      data: {
        tenantId: inv.tenantId,
        certP12Encrypted: Buffer.from('x'),
        certPasswordEncrypted: 'x',
        certCommonName: 'TEST',
        certNif: 'B12345674',
        certIssuer: 'CN=FNMT',
        certValidFrom: new Date(Date.now() - 300 * DAY),
        certValidTo: new Date(Date.now() + 10 * DAY),
        uploadedById: ownerUser.id,
      },
    });

    const health = await request(app.getHttpServer()).get('/admin/billing-health').set(adminAuth);
    expect(health.status).toBe(200);
    const row = health.body.tenants.find((t: { tenantId: string }) => t.tenantId === inv.tenantId);
    expect(row).toMatchObject({ aeatRejected: 1, certificateDaysLeft: 10, invoicingMode: 'app' });
    const issue = health.body.invoices.find(
      (i: { invoiceId: string }) => i.invoiceId === invoiceId,
    );
    expect(issue).toMatchObject({
      aeatStatus: 'rejected',
      message: 'NIF del destinatario no censado',
    });

    const today = await request(app.getHttpServer()).get('/admin/today').set(adminAuth);
    expect(
      today.body.aeatIssues.some((t: { tenantId: string }) => t.tenantId === inv.tenantId),
    ).toBe(true);
    expect(
      today.body.certificatesExpiring.some(
        (c: { tenantId: string; daysLeft: number }) =>
          c.tenantId === inv.tenantId && c.daysLeft === 10,
      ),
    ).toBe(true);

    // Aviso al tenant una sola vez por hito.
    const expiry = app.get(AeatCertExpiryService);
    expect(await expiry.run()).toBeGreaterThanOrEqual(1);
    const notified = await admin.notification.count({
      where: { tenantId: inv.tenantId, type: 'aeat.certificate_expiring' },
    });
    expect(notified).toBe(1);
    await expiry.run();
    expect(
      await admin.notification.count({
        where: { tenantId: inv.tenantId, type: 'aeat.certificate_expiring' },
      }),
    ).toBe(1);

    await request(app.getHttpServer()).get('/admin/billing-health').expect(401);
  });
});
