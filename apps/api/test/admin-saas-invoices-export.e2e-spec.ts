import request from 'supertest';

import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Admin: export contable CSV de facturas SaaS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupSuperAdmins();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupSuperAdmins();
  });

  it('exporta el CSV (cabecera + BOM) para un año, y rechaza sin token', async () => {
    // Sin token → 401.
    await request(app.getHttpServer()).get('/admin/platform-billing/export?year=2026').expect(401);

    const admin = await seedSuperAdmin('saas-export');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: admin.email, password: admin.password });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Export de un año (con o sin facturas): 200, text/csv, cabecera + BOM.
    const res = await request(app.getHttpServer())
      .get('/admin/platform-billing/export?year=2026')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('facturas-saas-2026.csv');
    const body = res.text;
    // BOM UTF-8 al inicio.
    expect(body.charCodeAt(0)).toBe(0xfeff);
    // Cabecera con las columnas esperadas.
    expect(body).toContain('Nº factura');
    expect(body).toContain('Base imponible');
    expect(body).toContain('Total');
    expect(body).toContain('Estado');

    // Sin `year` → cae al año actual (200 + filename del año en curso).
    const current = new Date().getUTCFullYear();
    const res2 = await request(app.getHttpServer()).get('/admin/platform-billing/export').set(auth);
    expect(res2.status).toBe(200);
    expect(res2.headers['content-disposition']).toContain(`facturas-saas-${current}.csv`);
  });
});
