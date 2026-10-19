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
        periodStart: new Date('2026-02-01'),
        periodEnd: new Date('2026-02-28'),
        items: {
          create: {
            tenantId: owner.tenantId,
            description: 'Alquiler trastero',
            unitPrice: 50,
            taxRate: 21,
            taxAmount: 10.5,
            total: 60.5,
          },
        },
      },
    });
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        customerId: customer.body.id,
        invoiceId: overdue.id,
        amount: 60.5,
        methodType: 'card',
        gateway: 'stripe',
        status: 'failed',
        failureReason: 'card_declined',
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

    await db.accessCredential.create({
      data: {
        tenantId: owner.tenantId,
        customerId: customer.body.id,
        method: 'pin',
        status: 'suspended',
        suspendReason: `dunning:invoice-${overdue.id}`,
        suspendedAt: new Date(),
      },
    });

    const before = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(before.body.kpis.debtorsWithoutPortal).toBe(1);

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
    const pa1 = invoices.body.find((i: { invoiceNumber: string }) => i.invoiceNumber === 'PA-1');
    expect(pa1).toMatchObject({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      lines: [{ description: 'Alquiler trastero', total: 60.5 }],
      lastFailure: { reason: 'El banco rechazó el cobro' },
    });
    expect(pa1.unitCode).toBeTruthy();
    // Con un cobro en marcha no se enseña el fallo anterior.
    const pa2 = invoices.body.find((i: { invoiceNumber: string }) => i.invoiceNumber === 'PA-2');
    expect(pa2.lastFailure).toBeNull();

    const contracts = await http().get('/portal/me/contracts').set(pAuth).expect(200);
    expect(contracts.body[0]).toMatchObject({ effectivePrice: 50, effectivePriceWithVat: 60.5 });

    // El acceso suspendido sale con el motivo y sin el código.
    const access = await http().get('/portal/me/access').set(pAuth).expect(200);
    const blocked = access.body.find((c: { status: string }) => c.status === 'suspended');
    expect(blocked).toMatchObject({
      value: null,
      suspension: { unpaid: true, invoiceNumber: 'PA-1', pending: 60.5 },
    });

    // Queda anotada la visita y deja de contar como «sin portal».
    await new Promise((r) => setTimeout(r, 300));
    const seen = await db.customer.findUniqueOrThrow({ where: { id: customer.body.id } });
    expect(seen.portalLastSeenAt).not.toBeNull();
    const after = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(after.body.kpis.debtorsWithoutPortal).toBe(0);
    const overview = await http().get('/customers/overview').set(auth).expect(200);
    expect(
      overview.body.find((r: { id: string }) => r.id === customer.body.id).portalLastSeenAt,
    ).toBeTruthy();

    await http().get('/portal/me/account').expect(401);
  });
});
