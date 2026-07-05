import { getQueueToken } from '@nestjs/bullmq';
import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-lifecycle-test@storageos.local';

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
}

describe('Tenant lifecycle emails (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;
  let emailQueue: TestQueue;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Lifecycle Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    // Pausamos la cola `email`: el run encola los emails; el test verifica el
    // registro de idempotencia, no el envío real. Evita que el worker la drene.
    emailQueue = app.get<TestQueue>(getQueueToken('email'), { strict: false });
    await emailQueue.pause();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    try {
      await emailQueue.obliterate({ force: true });
    } catch {
      // best-effort
    }
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('encola el recordatorio de trial (t1) una vez y es idempotente', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const owner = await registerVerifiedUser(app, 'admin-lifecycle');

    // El tenant nace en trial; ajustamos su fin de trial a +12h para que entre
    // en la ventana del hito trial_t1 ([now, now+1d]).
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await adminClient.tenant.update({
      where: { id: owner.tenantId },
      data: { status: 'trial', trialEndsAt: soon },
    });

    // Activamos SOLO los recordatorios de trial (el tenant recién registrado
    // también entraría en `welcome` por su createdAt <48h; lo desactivamos para
    // que la aserción del registro sea inequívoca).
    const settings = {
      enabled: false,
      alertEmail: '',
      notifyPastDue: true,
      notifyTrialExpiring: true,
      trialExpiringDays: 7,
      lifecycleEnabled: true,
      sendWelcome: false,
      sendTrialReminders: true,
      sendPastDue: false,
    };
    const put = await request(app.getHttpServer())
      .put('/admin/platform-alerts')
      .set(auth)
      .send(settings);
    expect(put.status).toBe(200);
    expect(put.body.lifecycleEnabled).toBe(true);

    // Ejecutar ahora → encola el recordatorio de trial de este tenant.
    const run1 = await request(app.getHttpServer()).post('/admin/tenant-lifecycle/run').set(auth);
    expect(run1.status).toBe(200);
    expect(run1.body.trialReminders).toBeGreaterThanOrEqual(1);

    // Se registró exactamente una fila `trial_t1` para el tenant.
    const rows = await adminClient.tenantLifecycleEmail.findMany({
      where: { tenantId: owner.tenantId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('trial_t1');

    // Idempotencia: una segunda ejecución NO vuelve a contar/registrar este tenant.
    const run2 = await request(app.getHttpServer()).post('/admin/tenant-lifecycle/run').set(auth);
    expect(run2.status).toBe(200);
    const rowsAfter = await adminClient.tenantLifecycleEmail.count({
      where: { tenantId: owner.tenantId, type: 'trial_t1' },
    });
    expect(rowsAfter).toBe(1);

    // Sin token → 401.
    const noAuth = await request(app.getHttpServer()).post('/admin/tenant-lifecycle/run');
    expect(noAuth.status).toBe(401);
  });
});
