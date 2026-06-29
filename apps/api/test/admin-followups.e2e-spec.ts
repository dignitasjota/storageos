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

const ADMIN_EMAIL = 'admin-followups-test@storageos.local';

describe('Admin tenant followups (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Followups Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('crear → bandeja → marcar hecho → borrar', async () => {
    const owner = await registerVerifiedUser(app, 'admin-fu');

    // Crear.
    const created = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth())
      .send({ title: 'Llamar para renovación', dueDate: '2026-07-15', note: 'tras el trial' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: 'Llamar para renovación',
      dueDate: '2026-07-15',
      status: 'pending',
      tenantId: owner.tenantId,
    });
    expect(created.body.tenantName).toBeTruthy();
    const followupId = created.body.id as string;

    // Lista del tenant.
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${owner.tenantId}/followups`)
      .set(auth());
    expect(list.body.some((f: { id: string }) => f.id === followupId)).toBe(true);

    // Bandeja global de pendientes.
    const pending = await request(app.getHttpServer()).get('/admin/followups').set(auth());
    expect(pending.body.some((f: { id: string }) => f.id === followupId)).toBe(true);

    // Marcar hecho.
    const done = await request(app.getHttpServer())
      .patch(`/admin/followups/${followupId}`)
      .set(auth())
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).toBeTruthy();

    // Ya no aparece en la bandeja de pendientes.
    const pendingAfter = await request(app.getHttpServer()).get('/admin/followups').set(auth());
    expect(pendingAfter.body.some((f: { id: string }) => f.id === followupId)).toBe(false);

    // Borrar.
    const del = await request(app.getHttpServer())
      .delete(`/admin/followups/${followupId}`)
      .set(auth());
    expect(del.status).toBe(204);
  });

  it('exige token de super admin', async () => {
    const res = await request(app.getHttpServer()).get('/admin/followups');
    expect(res.status).toBe(401);
  });
});
