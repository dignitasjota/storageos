import { getQueueToken } from '@nestjs/bullmq';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

interface TestQueue {
  pause: () => Promise<void>;
  obliterate: (opts: { force: boolean }) => Promise<void>;
}

/** Acciones masivas de la lista de tenants del panel admin. */
describe('Admin: acciones masivas sobre tenants (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let emailQueue: TestQueue;
  let superAuth: Record<string, string>;
  let supportAuth: Record<string, string>;

  async function login(email: string, password: string): Promise<Record<string, string>> {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password });
    return { Authorization: `Bearer ${res.body.accessToken as string}` };
  }

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
    emailQueue = app.get<TestQueue>(getQueueToken('email'), { strict: false });
    await emailQueue.pause();
    const sa = await seedSuperAdmin('bulk-super');
    superAuth = await login(sa.email, sa.password);
    const sup = await seedSuperAdmin('bulk-support');
    await db.superAdmin.update({ where: { email: sup.email }, data: { role: 'support' } });
    supportAuth = await login(sup.email, sup.password);
  });

  afterAll(async () => {
    await emailQueue.obliterate({ force: true });
    await app.close();
    await db.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('etiqueta en bloque (también soporte) y envía el correo solo a los seleccionados', async () => {
    const a = await registerVerifiedUser(app, 'bulka');
    const b = await registerVerifiedUser(app, 'bulkb');
    const c = await registerVerifiedUser(app, 'bulkc');
    const http = () => request(app.getHttpServer());

    const tagged = await http()
      .post('/admin/tenants/bulk-tags')
      .set(supportAuth)
      .send({ tenantIds: [a.tenantId, b.tenantId], add: ['piloto', 'madrid'] })
      .expect(200);
    expect(tagged.body.updated).toBe(2);
    await http()
      .post('/admin/tenants/bulk-tags')
      .set(superAuth)
      .send({ tenantIds: [a.tenantId], remove: ['madrid'] })
      .expect(200);
    const tags = await db.tenant.findMany({
      where: { id: { in: [a.tenantId, b.tenantId, c.tenantId] } },
      select: { id: true, tags: true },
    });
    const byId = new Map(tags.map((t) => [t.id, t.tags]));
    expect(byId.get(a.tenantId)).toEqual(['piloto']);
    expect(byId.get(b.tenantId)).toEqual(['piloto', 'madrid']);
    expect(byId.get(c.tenantId)).toEqual([]);
    await http()
      .post('/admin/tenants/bulk-tags')
      .set(superAuth)
      .send({ tenantIds: [a.tenantId] })
      .expect(400);

    const sent = await http()
      .post('/admin/announcements')
      .set(superAuth)
      .send({
        audience: 'all',
        tenantIds: [a.tenantId, c.tenantId],
        subject: 'Novedad para vosotros',
        body: 'Hola',
      })
      .expect(200);
    expect(sent.body.tenants).toBe(2);
    expect(sent.body.recipients).toBe(2);

    await http()
      .post('/admin/announcements')
      .set(supportAuth)
      .send({ audience: 'all', tenantIds: [a.tenantId], subject: 'No', body: 'No' })
      .expect(403);
  });
});
