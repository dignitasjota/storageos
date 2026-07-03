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
const ADMIN_EMAIL = 'admin-churn-test@storageos.local';

/** Churn de tenants agrupado por motivo (capturado al suspender + inferido). */
describe('Churn por razón (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let token: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Churn',
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
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('captura el motivo al suspender y lo agrega en el reporte; infiere el que falta', async () => {
    const bearer = { Authorization: `Bearer ${token}` };
    const a = await registerVerifiedUser(app, 'churn-a'); // starter, 49 €/mes
    const b = await registerVerifiedUser(app, 'churn-b');

    // A: baja con motivo capturado 'price'.
    const suspA = await request(app.getHttpServer())
      .post(`/admin/tenants/${a.tenantId}/suspend`)
      .set(bearer)
      .send({ reason: 'Se va por precio', churnReason: 'price' });
    expect(suspA.status).toBe(200);
    expect(suspA.body.status).toBe('suspended');

    // B: baja SIN motivo → el reporte lo infiere (starter activo → 'unknown').
    await request(app.getHttpServer())
      .post(`/admin/tenants/${b.tenantId}/suspend`)
      .set(bearer)
      .send({ reason: 'Sin especificar' })
      .expect(200);

    // El tenant guarda el motivo capturado.
    const rowA = await admin.tenant.findUnique({ where: { id: a.tenantId } });
    expect(rowA!.churnReason).toBe('price');
    expect(rowA!.canceledAt).toBeTruthy();

    const report = await request(app.getHttpServer())
      .get('/admin/metrics/churn-by-reason?months=12')
      .set(bearer);
    expect(report.status).toBe(200);
    expect(report.body.totalChurned).toBeGreaterThanOrEqual(2);

    const price = report.body.slices.find((s: { reason: string }) => s.reason === 'price');
    expect(price).toBeTruthy();
    expect(price.count).toBeGreaterThanOrEqual(1);
    expect(price.captured).toBeGreaterThanOrEqual(1);
    expect(price.lostMrr).toBeGreaterThanOrEqual(49); // starter

    // B aparece como inferido (unknown), no como 'price'.
    const inferred = report.body.slices.find(
      (s: { reason: string }) => s.reason === 'unknown' || s.reason === 'voluntary',
    );
    expect(inferred).toBeTruthy();

    // Reactivar A limpia el motivo → deja de ser churn.
    await request(app.getHttpServer())
      .post(`/admin/tenants/${a.tenantId}/reactivate`)
      .set(bearer)
      .send({ reason: 'vuelve' })
      .expect(200);
    const rowA2 = await admin.tenant.findUnique({ where: { id: a.tenantId } });
    expect(rowA2!.churnReason).toBeNull();
    expect(rowA2!.canceledAt).toBeNull();
  });

  it('sin token → 401', async () => {
    await request(app.getHttpServer()).get('/admin/metrics/churn-by-reason').expect(401);
  });
});
