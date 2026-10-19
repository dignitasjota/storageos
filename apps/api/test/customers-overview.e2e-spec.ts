import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Visión de los inquilinos (lista con cuota, cobro y deuda) y estado de cuenta de la ficha. */
describe('Inquilinos: visión y estado de cuenta (e2e)', () => {
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

  it('lista cuota, trastero, cobro, deuda y seguimiento; la ficha da el estado de cuenta', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'custoverview');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });

    const ana = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ana', lastName: 'Ruiz', country: 'ES' })
      .expect(201);
    const lead = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'business', companyName: 'Sin Contrato SL', country: 'ES' })
      .expect(201);

    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: ana.body.id,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 50,
        discountAmount: 5,
        depositAmount: 0,
      })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);

    // Factura vencida de 60 € (pagados 10) → debe 50.
    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    await db.invoice.create({
      data: {
        tenantId: owner.tenantId,
        customerId: ana.body.id,
        contractId: contract.body.id,
        seriesId,
        invoiceNumber: 'OV-1',
        sequenceNumber: 9001,
        status: 'overdue',
        issueDate: new Date('2026-02-01'),
        dueDate: new Date('2026-02-10'),
        subtotal: 60,
        taxAmount: 0,
        total: 60,
        amountPaid: 10,
      },
    });
    await http()
      .post(`/customers/${ana.body.id}/followups`)
      .set(auth)
      .send({ title: 'Llamar por la deuda', dueDate: '2026-12-01' })
      .expect(201);

    const list = await http().get('/customers/overview').set(auth).expect(200);
    const rowAna = list.body.find((r: { id: string }) => r.id === ana.body.id);
    expect(rowAna).toMatchObject({
      displayName: 'Ana Ruiz',
      monthly: 45,
      contractStatus: 'active',
      payVia: null,
      overdue: 50,
      overdueSince: '2026-02-10',
      nextFollowup: { title: 'Llamar por la deuda', dueDate: '2026-12-01' },
    });
    expect(rowAna.units).toHaveLength(1);
    const rowLead = list.body.find((r: { id: string }) => r.id === lead.body.id);
    expect(rowLead).toMatchObject({ contractStatus: 'none', monthly: 0, overdue: 0 });

    const account = await http().get(`/customers/${ana.body.id}/account`).set(auth).expect(200);
    expect(account.body).toMatchObject({
      monthly: 45,
      payVia: null,
      autoCharge: false,
      overdue: { amount: 50, since: '2026-02-10' },
    });
    expect(account.body.lines[0]).toMatchObject({ rent: 50, discount: 5, total: 45 });
    expect(account.body.nextCharge.amount).toBe(45);

    await http()
      .get('/customers/00000000-0000-0000-0000-000000000000/account')
      .set(auth)
      .expect(404);
    await http().get('/customers/overview').expect(401);
  });
});
