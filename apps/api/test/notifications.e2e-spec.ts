import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Notifications + revenue KPIs (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('feed vacío por defecto', async () => {
    const owner = await registerVerifiedUser(app, 'notif-empty');
    const res = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unreadCount: 0 });
  });

  it('crear un lead genera una notificación; marcar leída baja el contador', async () => {
    const owner = await registerVerifiedUser(app, 'notif-lead');
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ firstName: 'Carla', lastName: 'Ruiz', email: 'carla@e2e.local' });
    expect(lead.status).toBe(201);

    // El listener es async: reintenta hasta que aparezca la notificación.
    let body: { items: { id: string; type: string }[]; unreadCount: number } | null = null;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${owner.accessToken}`);
      body = res.body;
      if ((body?.unreadCount ?? 0) > 0) break;
      await sleep(300);
    }
    expect(body?.unreadCount).toBeGreaterThan(0);
    const notif = body!.items.find((n) => n.type === 'lead.created');
    expect(notif).toBeTruthy();

    const read = await request(app.getHttpServer())
      .post(`/notifications/${notif!.id}/read`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(read.status).toBe(204);

    const after = await request(app.getHttpServer())
      .get('/notifications')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.body.unreadCount).toBe(0);
  });

  it('revenue KPIs: tenant vacío devuelve ceros', async () => {
    const owner = await registerVerifiedUser(app, 'notif-revenue');
    const res = await request(app.getHttpServer())
      .get('/analytics/revenue')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mrr: 0, totalUnits: 0, revPau: 0 });
  });
});
