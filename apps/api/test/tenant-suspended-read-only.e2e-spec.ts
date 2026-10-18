import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Un tenant suspendido (impago de la suscripción) queda en solo lectura: puede
 * consultar, pagar y pedir ayuda, pero no trabajar; su web no acepta reservas y
 * sus inquilinos no entran al área de clientes. Al volver a `active` (lo hace
 * el pago), todo funciona otra vez.
 */
describe('Tenant suspendido: panel en solo lectura (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('bloquea los cambios salvo pagar y soporte, y se reactiva al volver a active', async () => {
    const owner = await registerVerifiedUser(app, 'suspro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    await createCustomer(app, owner.accessToken);

    await admin.tenant.update({ where: { slug: owner.slug }, data: { status: 'suspended' } });

    // Leer sí.
    await http().get('/customers').set(auth).expect(200);
    const status = await http().get('/settings/billing-status').set(auth).expect(200);
    expect(status.body.suspended).toBe(true);
    expect(status.body.hasIssue).toBe(true);

    // Trabajar no.
    const blocked = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Ruiz' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('tenant_suspended_read_only');

    // Pedir ayuda y gestionar su cuenta, sí.
    await http()
      .post('/support/tickets')
      .set(auth)
      .send({ subject: 'Quiero pagar', body: 'Hola', priority: 'high' })
      .expect(201);
    await http().patch('/me').set(auth).send({ fullName: 'Dueño Suspendido' }).expect(200);

    // Su web no acepta reservas.
    const booking = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    expect(booking.status).toBe(409);
    expect(booking.body.code).toBe('booking_unavailable');

    // Pagado (el pago lo pasa a active) → vuelve a funcionar.
    await admin.tenant.update({ where: { slug: owner.slug }, data: { status: 'active' } });
    await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Ruiz' })
      .expect(201);
    expect((await http().get('/settings/billing-status').set(auth)).body.suspended).toBe(false);
  });
});
