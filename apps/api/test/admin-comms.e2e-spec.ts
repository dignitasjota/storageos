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

const ADMIN_EMAIL = 'admin-comms-test@storageos.local';

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
}

describe('Admin comms (email + broadcast) (e2e)', () => {
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
        fullName: 'Admin Comms Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    // Pausamos la cola `email`: el broadcast a todos los tenants puede encolar
    // muchos jobs en una BD local con tenants residuales; el test verifica el
    // encolado por la respuesta del endpoint, no el envío real.
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
    // Borramos los jobs encolados (la cola estaba pausada) para que el cierre
    // del worker sea inmediato.
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

  it('envía un email directo al tenant y un broadcast', async () => {
    const owner = await registerVerifiedUser(app, 'admin-comms');
    const auth = { Authorization: `Bearer ${token}` };

    // Email directo → llega al owner verificado
    const direct = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(auth)
      .send({ subject: 'Aviso importante', body: 'Hola, esto es una prueba.' });
    expect(direct.status).toBe(200);
    expect(direct.body.recipients).toBeGreaterThanOrEqual(1);
    expect(direct.body.failed).toBe(0);

    // El email queda registrado en el histórico de conversaciones del tenant.
    const interactions = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/interactions`)
      .set(auth);
    expect(interactions.status).toBe(200);
    const emailEntry = interactions.body.find(
      (i: { type: string; content: string }) =>
        i.type === 'email' && i.content.includes('Aviso importante'),
    );
    expect(emailEntry).toBeTruthy();

    // Validación: asunto demasiado corto -> 400
    const bad = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/email`)
      .set(auth)
      .send({ subject: 'x', body: 'cuerpo' });
    expect(bad.status).toBe(400);

    // Tenant inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .post('/admin/tenants/00000000-0000-0000-0000-000000000000/email')
      .set(auth)
      .send({ subject: 'Hola tenant', body: 'mensaje' });
    expect(ghost.status).toBe(404);

    // Broadcast a trials (el tenant nuevo está en trial) → alcanza ≥1 tenant
    const broadcast = await request(app.getHttpServer())
      .post('/admin/announcements')
      .set(auth)
      .send({ audience: 'trial', subject: 'Mantenimiento programado', body: 'El sábado a las 3.' });
    expect(broadcast.status).toBe(200);
    expect(broadcast.body.tenants).toBeGreaterThanOrEqual(1);
    expect(broadcast.body.recipients).toBeGreaterThanOrEqual(1);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer())
      .post('/admin/announcements')
      .send({ audience: 'all', subject: 'Hola', body: 'sin token' });
    expect(noAuth.status).toBe(401);
  });
});
