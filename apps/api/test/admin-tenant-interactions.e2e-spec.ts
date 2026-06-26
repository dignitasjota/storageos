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

const ADMIN_EMAIL = 'admin-ti-test@storageos.local';

describe('Admin tenant interactions (e2e)', () => {
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
        fullName: 'Admin TI Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();

    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    if (login.status !== 200 && login.status !== 201) {
      throw new Error(`super admin login fallo: ${login.status} ${JSON.stringify(login.body)}`);
    }
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('registra, lista y borra conversaciones; aísla por tenant', async () => {
    const a = await registerVerifiedUser(app, 'admin-ti-a');
    const b = await registerVerifiedUser(app, 'admin-ti-b');

    // GET vacío al inicio
    const empty = await request(app.getHttpServer())
      .get(`/admin/tenants/${a.tenantId}/interactions`)
      .set('Authorization', `Bearer ${token}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    // POST crea una conversación; el autor (super admin) se rellena desde el token
    const created = await request(app.getHttpServer())
      .post(`/admin/tenants/${a.tenantId}/interactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'call', content: 'Llamada de onboarding; pide ayuda con Stripe.' });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe('call');
    expect(created.body.authorName).toBe('Admin TI Test');
    const interactionId = created.body.id as string;

    // GET lista incluye la conversación
    const list = await request(app.getHttpServer())
      .get(`/admin/tenants/${a.tenantId}/interactions`)
      .set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].content).toContain('Stripe');

    // Aislamiento: el tenant B no ve la conversación de A
    const otherList = await request(app.getHttpServer())
      .get(`/admin/tenants/${b.tenantId}/interactions`)
      .set('Authorization', `Bearer ${token}`);
    expect(otherList.body).toEqual([]);

    // POST sobre un tenant inexistente -> 404
    const ghost = await request(app.getHttpServer())
      .post(`/admin/tenants/00000000-0000-0000-0000-000000000000/interactions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'note', content: 'fantasma' });
    expect(ghost.status).toBe(404);

    // DELETE con el tenant equivocado -> 404 (no es de B)
    const crossDelete = await request(app.getHttpServer())
      .delete(`/admin/tenants/${b.tenantId}/interactions/${interactionId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(crossDelete.status).toBe(404);

    // DELETE correcto -> 204
    const del = await request(app.getHttpServer())
      .delete(`/admin/tenants/${a.tenantId}/interactions/${interactionId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const afterDelete = await request(app.getHttpServer())
      .get(`/admin/tenants/${a.tenantId}/interactions`)
      .set('Authorization', `Bearer ${token}`);
    expect(afterDelete.body).toEqual([]);

    // Sin token -> 401
    const noAuth = await request(app.getHttpServer()).get(
      `/admin/tenants/${a.tenantId}/interactions`,
    );
    expect(noAuth.status).toBe(401);
  });
});
