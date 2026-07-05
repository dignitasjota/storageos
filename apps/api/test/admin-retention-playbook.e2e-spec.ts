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

const ADMIN_EMAIL = 'admin-retention-test@storageos.local';

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
}

describe('Admin retention playbook (e2e)', () => {
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
        fullName: 'Admin Retention Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    // Pausamos la cola `email`: el playbook encola el email de retención; el
    // test verifica el encolado por la respuesta, no el envío real.
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
    // Vaciamos la cola pausada para que el cierre del worker sea inmediato.
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

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('lanza el playbook: seguimiento + email + interacción', async () => {
    const owner = await registerVerifiedUser(app, 'admin-ret');

    const res = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/retention-playbook`)
      .set(auth())
      .send({ note: 'Cliente inactivo, ofrecer ayuda' });
    expect(res.status).toBe(200);
    expect(res.body.followupId).toBeTruthy();
    // El owner está verificado → al menos un destinatario.
    expect(res.body.emailRecipients).toBeGreaterThanOrEqual(1);

    // Se creó el seguimiento en BD (dueDate = hoy + 3 días).
    const followup = await adminClient.tenantFollowup.findFirst({
      where: { id: res.body.followupId as string, tenantId: owner.tenantId },
    });
    expect(followup).not.toBeNull();
    expect(followup?.status).toBe('pending');
    expect(followup?.title).toContain('Retención');

    // Se registró la interacción de la gestión.
    const interactions = await adminClient.tenantInteraction.findMany({
      where: { tenantId: owner.tenantId },
    });
    const playbookEntry = interactions.find((i) =>
      i.content.includes('Playbook de retención lanzado'),
    );
    expect(playbookEntry).toBeTruthy();
    expect(playbookEntry?.type).toBe('note');
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/tenants/00000000-0000-0000-0000-000000000000/retention-playbook')
      .send({});
    expect(res.status).toBe(401);
  });
});
