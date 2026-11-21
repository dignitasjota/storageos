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

const DAY = 86_400_000;

describe('Novedades: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const createdIds: string[] = [];

  /** Novedad publicada directamente en la base de datos con la fecha indicada. */
  async function publishAt(title: string, publishedAt: Date, highlighted = false) {
    const row = await admin.productUpdate.create({
      data: {
        title,
        body: 'Texto de la novedad',
        category: 'new',
        highlighted,
        publishedAt,
        firstPublishedAt: publishedAt,
      },
    });
    createdIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    await cleanupSuperAdmins();
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.productUpdate.deleteMany({ where: { id: { in: createdIds } } });
    await admin.$disconnect();
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  it('un usuario nuevo no ve como sin leer lo publicado antes de su alta', async () => {
    const old = await publishAt('Novedad antigua e2e', new Date(Date.now() - 180 * DAY), true);
    const owner = await registerVerifiedUser(app, 'upd-new-user');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const unread = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(auth);
    expect(unread.status).toBe(200);
    expect(unread.body.count).toBe(0);

    const list = await request(app.getHttpServer()).get('/product-updates').set(auth);
    const item = (list.body as { id: string; unread: boolean }[]).find((u) => u.id === old.id);
    expect(item).toMatchObject({ unread: false });

    // La destacada antigua no sale en la ventana del panel.
    const highlighted = await request(app.getHttpServer())
      .get('/product-updates/highlighted')
      .set(auth);
    expect(highlighted.status).toBe(200);
    expect(highlighted.body.update?.id).not.toBe(old.id);

    // Lo que se publica después de su alta sí cuenta como sin leer.
    const fresh = await publishAt('Novedad reciente e2e', new Date(), true);
    const after = await request(app.getHttpServer()).get('/product-updates/unread-count').set(auth);
    expect(after.body.count).toBeGreaterThanOrEqual(1);
    const hl = await request(app.getHttpServer()).get('/product-updates/highlighted').set(auth);
    expect(hl.body.update).toMatchObject({ id: fresh.id, unread: true });
  });

  it('la destacada sin leer de hace más de 30 días no sale al entrar', async () => {
    const owner = await registerVerifiedUser(app, 'upd-old-user');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    // Usuario dado de alta hace 90 días que nunca abrió «Novedades».
    await admin.user.update({
      where: { id: owner.userId },
      data: { createdAt: new Date(Date.now() - 90 * DAY), productUpdatesSeenAt: null },
    });
    const stale = await publishAt(
      'Destacada de hace 40 días e2e',
      new Date(Date.now() - 40 * DAY),
      true,
    );

    const page = await request(app.getHttpServer()).get('/product-updates/page').set(auth);
    const item = (page.body.items as { id: string; unread: boolean }[]).find(
      (u) => u.id === stale.id,
    );
    expect(item?.unread).toBe(true);

    const hl = await request(app.getHttpServer()).get('/product-updates/highlighted').set(auth);
    expect(hl.body.update?.id).not.toBe(stale.id);
  });

  it('pagina por cursor sin repetir y devuelve hasta cuándo estaban leídas', async () => {
    await publishAt('Página A e2e', new Date(Date.now() - 2 * DAY));
    await publishAt('Página B e2e', new Date(Date.now() - 3 * DAY));
    const owner = await registerVerifiedUser(app, 'upd-page');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const first = await request(app.getHttpServer()).get('/product-updates/page?limit=1').set(auth);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    expect(typeof first.body.readUntil).toBe('string');

    const second = await request(app.getHttpServer())
      .get(`/product-updates/page?limit=1&cursor=${first.body.nextCursor}`)
      .set(auth);
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
    expect(new Date(second.body.items[0].publishedAt).getTime()).toBeLessThanOrEqual(
      new Date(first.body.items[0].publishedAt).getTime(),
    );

    await request(app.getHttpServer())
      .get('/product-updates/page?cursor=no-es-un-id')
      .set(auth)
      .expect(400);
  });

  it('durante una impersonación, marcar como vistas no gasta la marca del usuario', async () => {
    const owner = await registerVerifiedUser(app, 'upd-imp');
    await admin.user.update({
      where: { id: owner.userId },
      data: { createdAt: new Date(Date.now() - 10 * DAY), productUpdatesSeenAt: null },
    });
    await publishAt('Para el propietario e2e', new Date(Date.now() - DAY));
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const before = (
      await request(app.getHttpServer()).get('/product-updates/unread-count').set(ownerAuth)
    ).body.count as number;
    expect(before).toBeGreaterThanOrEqual(1);

    const sa = await seedSuperAdmin('upd-imp');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    const saAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    for (const readOnly of [true, false]) {
      const imp = await request(app.getHttpServer())
        .post(`/admin/tenants/${owner.tenantId}/impersonate`)
        .set(saAuth)
        .send({ reason: 'revisar novedades', readOnly });
      expect(imp.status).toBe(200);
      const impAuth = { Authorization: `Bearer ${imp.body.accessToken}` };
      await request(app.getHttpServer()).post('/product-updates/seen').set(impAuth).expect(204);
    }

    const user = await admin.user.findUnique({ where: { id: owner.userId } });
    expect(user?.productUpdatesSeenAt).toBeNull();
    const after = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(ownerAuth);
    expect(after.body.count).toBe(before);

    // El propio usuario sí la gasta.
    await request(app.getHttpServer()).post('/product-updates/seen').set(ownerAuth).expect(204);
    const mine = await request(app.getHttpServer())
      .get('/product-updates/unread-count')
      .set(ownerAuth);
    expect(mine.body.count).toBe(0);
  });
});
