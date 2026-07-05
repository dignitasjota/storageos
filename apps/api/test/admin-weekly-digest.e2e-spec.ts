import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: resumen semanal de KPIs (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('respeta el flag y envía el resumen al activarlo', async () => {
    const admin = await seedSuperAdmin('digest');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Sin token → 401.
    await request(app.getHttpServer()).post('/admin/weekly-digest/run').expect(401);

    // Estado explícito desactivado (el singleton es compartido y persiste entre
    // runs locales; en CI la BD es fresca). Con el resumen off → no envía.
    await request(app.getHttpServer()).put('/admin/platform-alerts').set(auth).send({
      enabled: false,
      alertEmail: '',
      notifyPastDue: true,
      notifyTrialExpiring: true,
      trialExpiringDays: 5,
      weeklyDigestEnabled: false,
    });
    const run0 = await request(app.getHttpServer()).post('/admin/weekly-digest/run').set(auth);
    expect(run0.status).toBe(200);
    expect(run0.body.sent).toBe(false);
    expect(run0.body.reason).toBe('disabled_or_no_email');

    // Activar el resumen semanal + email de destino (vía el singleton compartido).
    // `enabled: false` a propósito: el resumen semanal es independiente de las
    // alertas y así no ensuciamos el singleton para el spec de platform-alerts.
    const upd = await request(app.getHttpServer()).put('/admin/platform-alerts').set(auth).send({
      enabled: false,
      alertEmail: 'fundador@storageos.local',
      notifyPastDue: true,
      notifyTrialExpiring: true,
      trialExpiringDays: 5,
      weeklyDigestEnabled: true,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.weeklyDigestEnabled).toBe(true);

    // Run activado: el EmailProvider de test es un stub (no falla) → envía.
    const run1 = await request(app.getHttpServer()).post('/admin/weekly-digest/run').set(auth);
    expect(run1.status).toBe(200);
    expect(run1.body.sent).toBe(true);
    expect(run1.body.reason).toBeNull();
  });
});
