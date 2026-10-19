import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Matriz inquilino × extras y notas rápidas en la ficha. */
describe('Extras por inquilino (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('muestra qué tiene cada inquilino activo', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'custextras');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 40,
    });
    const make = async (firstName: string, unitId: string) => {
      const c = await http()
        .post('/customers')
        .set(auth)
        .send({ customerType: 'individual', firstName, lastName: 'Prueba', country: 'ES' })
        .expect(201);
      const k = await http()
        .post('/contracts')
        .set(auth)
        .send({
          customerId: c.body.id,
          unitId,
          startDate: '2026-01-01',
          priceMonthly: 40,
          depositAmount: 0,
        })
        .expect(201);
      await http().post(`/contracts/${k.body.id}/sign`).set(auth).send({}).expect(200);
      return c.body.id as string;
    };
    const ana = await make('Ana', unitIds[0]!);
    const luis = await make('Luis', unitIds[1]!);
    await db.customer.update({ where: { id: ana }, data: { portalPasswordHash: 'x' } });

    const res = await http().get('/customers/extras').set(auth).expect(200);
    expect(res.body.totals).toMatchObject({ customers: 2, portalPassword: 1, insured: 0 });
    const row = res.body.rows.find((r: { customerId: string }) => r.customerId === ana);
    expect(row).toMatchObject({ contracts: 1, monthly: 40, portalPassword: true, autopay: false });
    expect(
      res.body.rows.find((r: { customerId: string }) => r.customerId === luis).portalPassword,
    ).toBe(false);

    // Nota rápida desde la cabecera de la ficha.
    await http()
      .post(`/customers/${luis}/interactions`)
      .set(auth)
      .send({ type: 'call', content: 'Pregunta por un trastero más grande' })
      .expect(201);
    const notes = await http().get(`/customers/${luis}/interactions`).set(auth).expect(200);
    expect(notes.body[0]).toMatchObject({
      type: 'call',
      content: 'Pregunta por un trastero más grande',
    });

    await http().get('/customers/extras').expect(401);
  });
});
