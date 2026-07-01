import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Dashboard: bandeja «Hoy» (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('devuelve la bandeja operativa del día', async () => {
    const owner = await registerVerifiedUser(app, 'today');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await request(app.getHttpServer()).get('/dashboard/today').expect(401);

    const res = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(res.status).toBe(200);
    // Estructura del DTO (tenant nuevo → todo a 0).
    expect(res.body.tasksDue).toEqual({ count: 0, items: [] });
    expect(res.body.contractsEndingSoon).toEqual({ count: 0, items: [] });
    expect(res.body.reservationsExpiring).toEqual({ count: 0, items: [] });
    expect(res.body.invoicesOverdue).toEqual({ count: 0, totalPending: 0 });
    expect(res.body.incidentsOpen).toBe(0);
    expect(res.body.unitChangesPending).toBe(0);
    expect(res.body.unreadMessages).toBe(0);
    // Secciones nuevas (move-ins/outs, seguimientos, leads, firmas, vencen hoy) + cabecera.
    expect(typeof res.body.date).toBe('string');
    expect(res.body.urgentCount).toBe(0);
    expect(res.body.moveInsToday).toEqual({ count: 0, items: [] });
    expect(res.body.moveOutsToday).toEqual({ count: 0, items: [] });
    expect(res.body.followupsDue).toEqual({ count: 0, items: [] });
    expect(res.body.newLeads).toEqual({ count: 0, items: [] });
    expect(res.body.signaturesPending).toEqual({ count: 0, items: [] });
    expect(res.body.invoicesDueToday).toEqual({ count: 0, totalDue: 0 });
  });

  it('cuenta un lead nuevo y un seguimiento para hoy', async () => {
    const owner = await registerVerifiedUser(app, 'today2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Lead nuevo sin contactar.
    await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Lea', lastName: 'Nuevo', email: 'lea-today@x.com' })
      .expect(201);
    // Cliente + seguimiento con vencimiento hoy.
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Cli',
        lastName: 'Ente',
        email: 'cli-today@x.com',
      });
    const todayStr = new Date().toISOString().slice(0, 10);
    await request(app.getHttpServer())
      .post(`/customers/${customer.body.id}/followups`)
      .set(auth)
      .send({ title: 'Llamar', dueDate: todayStr })
      .expect(201);

    const res = await request(app.getHttpServer()).get('/dashboard/today').set(auth);
    expect(res.body.newLeads.count).toBe(1);
    expect(res.body.newLeads.items[0].label).toContain('Lea');
    expect(res.body.followupsDue.count).toBe(1);
    expect(res.body.followupsDue.items[0].linkId).toBe(customer.body.id);
    expect(res.body.urgentCount).toBeGreaterThanOrEqual(1);
  });
});
