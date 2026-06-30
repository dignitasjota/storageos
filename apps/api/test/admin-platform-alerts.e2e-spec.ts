import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: alertas de plataforma (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('configura las alertas y evalúa', async () => {
    const admin = await seedSuperAdmin('alerts');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    await request(app.getHttpServer()).get('/admin/platform-alerts').expect(401);

    // Estado inicial (singleton creado con defaults).
    const initial = await request(app.getHttpServer()).get('/admin/platform-alerts').set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body.enabled).toBe(false);

    // Run con alertas desactivadas → no envía.
    const run0 = await request(app.getHttpServer()).post('/admin/platform-alerts/run').set(auth);
    expect(run0.status).toBe(200);
    expect(run0.body.sent).toBe(false);
    expect(run0.body.reason).toBe('disabled_or_no_email');

    // Activar con email.
    const upd = await request(app.getHttpServer()).put('/admin/platform-alerts').set(auth).send({
      enabled: true,
      alertEmail: 'equipo@storageos.local',
      notifyPastDue: true,
      notifyTrialExpiring: true,
      trialExpiringDays: 5,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.enabled).toBe(true);
    expect(upd.body.alertEmail).toBe('equipo@storageos.local');

    // Run activado: sin señales en la BD de test → no_signals (o envía si hay).
    const run1 = await request(app.getHttpServer()).post('/admin/platform-alerts/run').set(auth);
    expect(run1.status).toBe(200);
    expect(['no_signals', null]).toContain(run1.body.reason);
  });
});
