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

/** «Mi cuenta» del portal: cuota con IVA, impago con sus pasos y lo que ya se cobra. */
describe('Portal: mi cuenta (e2e)', () => {
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

  it('muestra cuota con IVA, deuda con lo que pasará y lo que ya se está cobrando', async () => {
    const http = () => request(app.getHttpServer());
    const owner = await registerVerifiedUser(app, 'portalaccount');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 50,
    });
    const customer = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Lola', lastName: 'Gil', country: 'ES' })
      .expect(201);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: customer.body.id,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 50,
        depositAmount: 0,
      })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);

    const seriesId = await ensureDefaultSeries(app, owner.accessToken);
    const base = {
      tenantId: owner.tenantId,
      customerId: customer.body.id,
      contractId: contract.body.id,
      seriesId,
      subtotal: 50,
      taxAmount: 10.5,
      total: 60.5,
    };
    const overdue = await db.invoice.create({
      data: {
        ...base,
        invoiceNumber: 'PA-1',
        sequenceNumber: 9101,
        status: 'overdue',
        issueDate: new Date('2026-02-01'),
        dueDate: new Date('2026-02-10'),
      },
    });
    const collecting = await db.invoice.create({
      data: {
        ...base,
        invoiceNumber: 'PA-2',
        sequenceNumber: 9102,
        status: 'issued',
        issueDate: new Date('2026-03-01'),
        dueDate: new Date('2099-03-10'),
      },
    });
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        customerId: customer.body.id,
        invoiceId: collecting.id,
        amount: 60.5,
        methodType: 'sepa_debit',
        gateway: 'gocardless',
        status: 'processing',
      },
    });
    await db.dunningAction.createMany({
      data: [
        {
          tenantId: owner.tenantId,
          invoiceId: overdue.id,
          actionType: 'email_reminder',
          scheduledFor: new Date('2026-02-11'),
          executedAt: new Date('2026-02-11'),
          status: 'executed',
        },
        {
          tenantId: owner.tenantId,
          invoiceId: overdue.id,
          actionType: 'access_block',
          scheduledFor: new Date('2099-02-24'),
        },
      ],
    });

    const link = await http()
      .post(`/customers/${customer.body.id}/portal-link`)
      .set(auth)
      .expect(201);
    const token = new URL(link.body.url).searchParams.get('token');
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const pAuth = { Authorization: `Bearer ${session.body.accessToken}` };

    const account = await http().get('/portal/me/account').set(pAuth).expect(200);
    expect(account.body).toMatchObject({
      monthly: 60.5,
      payVia: null,
      automatic: false,
      inProgress: 60.5,
      pendingNotDue: 0,
      overdue: { amount: 60.5, since: '2026-02-10', accessBlocked: false },
    });
    expect(account.body.lines[0]).toMatchObject({ rent: 60.5, insurance: 0, total: 60.5 });
    expect(account.body.nextCharge.amount).toBe(60.5);
    const types = account.body.overdue.steps.map((s: { type: string; done: boolean }) => [
      s.type,
      s.done,
    ]);
    expect(types).toEqual([
      ['email_reminder', true],
      ['access_block', false],
    ]);

    const invoices = await http().get('/portal/me/invoices').set(pAuth).expect(200);
    const byNumber = Object.fromEntries(
      invoices.body.map((i: { invoiceNumber: string; paymentInProgress: boolean }) => [
        i.invoiceNumber,
        i.paymentInProgress,
      ]),
    );
    expect(byNumber).toEqual({ 'PA-1': false, 'PA-2': true });

    const contracts = await http().get('/portal/me/contracts').set(pAuth).expect(200);
    expect(contracts.body[0]).toMatchObject({ effectivePrice: 50, effectivePriceWithVat: 60.5 });

    await http().get('/portal/me/account').expect(401);
  });
});
