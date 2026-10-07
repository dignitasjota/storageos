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
const ADMIN_EMAIL = 'admin-updates-test@storageos.local';
const SUPPORT_EMAIL = 'support-updates-test@storageos.local';

describe('Novedades (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };
  let supportAuth: { Authorization: string };
  const createdIds: string[] = [];

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    for (const [email, role] of [
      [ADMIN_EMAIL, 'superadmin'],
      [SUPPORT_EMAIL, 'support'],
    ] as const) {
      await admin.superAdmin.create({
        data: { email, passwordHash: await argonHash('AdminTest!23'), fullName: email, role },
      });
    }
    app = await createTestApp();
    const login = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/admin/auth/login')
          .send({ email, password: 'AdminTest!23' })
      ).body.accessToken as string;
    adminAuth = { Authorization: `Bearer ${await login(ADMIN_EMAIL)}` };
    supportAuth = { Authorization: `Bearer ${await login(SUPPORT_EMAIL)}` };
  });

  afterAll(async () => {
    await app.close();
    await admin.productUpdate.deleteMany({ where: { id: { in: createdIds } } });
    await admin.superAdmin.deleteMany({ where: { email: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('el admin publica, el tenant la ve con aviso de no leída y la marca vista', async () => {
    const owner = await registerVerifiedUser(app, 'updates');
    const tenantAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const before = (
      await request(app.getHttpServer()).get('/product-updates/unread-count').set(tenantAuth)
    ).body.count as number;

    const draft = await request(app.getHttpServer())
      .post('/admin/product-updates')
      .set(adminAuth)
      .send({ title: 'Borrador e2e', body: 'Aún no', published: false });
    expect(draft.status).toBe(201);
    createdIds.push(draft.body.id);

    const pub = await request(app.getHttpServer())
      .post('/admin/product-updates')
      .set(adminAuth)
      .send({
        title: 'Remesas SEPA más rápidas',
        body: '**Nuevo**: confirma la remesa en un clic.',
        category: 'improvement',
        feature: 'sepa',
        link: '/sepa-remittances',
        published: true,
      });
    expect(pub.status).toBe(201);
    createdIds.push(pub.body.id);
    expect(pub.body.publishedAt).not.toBeNull();

    const unread = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(tenantAuth);
    expect(unread.body.count).toBe(before + 1);

    const list = await request(app.getHttpServer()).get('/product-updates').set(tenantAuth);
    const item = (
      list.body as { id: string; unread: boolean; featureIncluded: boolean | null }[]
    ).find((u) => u.id === pub.body.id);
    // El registro deja al tenant en «starter», que no incluye SEPA.
    expect(item).toMatchObject({ unread: true, featureIncluded: false });
    expect((list.body as { id: string }[]).some((u) => u.id === draft.body.id)).toBe(false);

    await request(app.getHttpServer()).post('/product-updates/seen').set(tenantAuth).expect(204);
    const after = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(tenantAuth);
    expect(after.body.count).toBe(0);

    // Corregir una novedad publicada no la vuelve a marcar como nueva.
    await request(app.getHttpServer())
      .put(`/admin/product-updates/${pub.body.id}`)
      .set(adminAuth)
      .send({ title: 'Remesas SEPA más rápidas', body: 'Texto corregido', published: true })
      .expect(200);
    const again = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(tenantAuth);
    expect(again.body.count).toBe(0);
  });

  it('soporte lee pero no publica; ruta del enlace validada', async () => {
    await request(app.getHttpServer()).get('/admin/product-updates').set(supportAuth).expect(200);
    await request(app.getHttpServer())
      .post('/admin/product-updates')
      .set(supportAuth)
      .send({ title: 'No debería', body: 'xxx', published: true })
      .expect(403);
    await request(app.getHttpServer())
      .post('/admin/product-updates')
      .set(adminAuth)
      .send({ title: 'Enlace externo', body: 'xxx', link: 'https://evil.example', published: true })
      .expect(400);
    await request(app.getHttpServer()).get('/product-updates').expect(401);
  });
});
