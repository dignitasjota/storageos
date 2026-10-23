import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { FirstInvoiceService } from '../src/modules/billing/first-invoice.service';
import { InvoicesService } from '../src/modules/billing/invoices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de facturación (2026-10-23): numeración que vuelve a 1 cada año,
 * vencimiento de los pagos de varios meses, aviso cuando la primera factura no
 * se emite y DNI/NIE válido en la reserva online con envío real a la AEAT.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Revisión de facturación (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('una serie por año vuelve a 1 con la primera factura del año siguiente', async () => {
    const owner = await registerVerifiedUser(app, 'billnum');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    const issueOn = async (issueDate: string): Promise<string> => {
      const draft = await http()
        .post('/invoices')
        .set(auth)
        .send({
          customerId,
          issueDate,
          items: [{ description: 'Cuota', quantity: 1, unitPrice: 10, taxRate: 21 }],
        });
      expect(draft.status).toBe(201);
      const issued = await http().post(`/invoices/${draft.body.id}/issue`).set(auth);
      expect(issued.status).toBe(200);
      return issued.body.invoiceNumber as string;
    };

    expect(await issueOn('2026-12-30')).toMatch(/\/2026\/00001$/);
    expect(await issueOn('2026-12-31')).toMatch(/\/2026\/00002$/);
    expect(await issueOn('2027-01-04')).toMatch(/\/2027\/00001$/);
    expect(await issueOn('2027-01-05')).toMatch(/\/2027\/00002$/);
  });

  it('el pago de varios meses vence a los 15 días del inicio, no del fin del periodo', async () => {
    const owner = await registerVerifiedUser(app, 'billdue');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 100,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Primer pago de 3 meses: la 1ª factura sale al firmar.
    const threeMonths = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-03-10',
      priceMonthly: 100,
      firstPaymentMonths: 3,
      depositAmount: 0,
    });
    expect(threeMonths.status).toBe(201);
    await http().post(`/contracts/${threeMonths.body.id}/sign`).set(auth).send({}).expect(200);
    const first = await adminClient.invoice.findFirstOrThrow({
      where: { contractId: threeMonths.body.id, kind: 'invoice' },
    });
    expect(first.periodEnd?.toISOString().slice(0, 10)).toBe('2026-06-09');
    expect(first.dueDate?.toISOString().slice(0, 10)).toBe('2026-03-25');

    // Prepago anual por la recurrente: vence a los 15 días del inicio.
    const annual = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[1],
      startDate: '2026-01-10',
      priceMonthly: 100,
      billingIntervalMonths: 12,
      depositAmount: 0,
    });
    expect(annual.status).toBe(201);
    await http().post(`/contracts/${annual.body.id}/sign`).set(auth).send({}).expect(200);
    await app.get(BillingJobsService).processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    });
    const yearly = await adminClient.invoice.findFirstOrThrow({
      where: { contractId: annual.body.id, kind: 'invoice' },
    });
    expect(yearly.periodEnd?.toISOString().slice(0, 10)).toBe('2027-01-09');
    expect(yearly.dueDate?.toISOString().slice(0, 10)).toBe('2026-01-25');
  });

  it('si la primera factura no se emite, el equipo recibe un aviso con el motivo', async () => {
    const owner = await registerVerifiedUser(app, 'billfirstfail');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-03-01',
      priceMonthly: 50,
      depositAmount: 0,
    });
    expect(contract.status).toBe(201);

    const spy = jest
      .spyOn(app.get(InvoicesService), 'issue')
      .mockRejectedValueOnce(
        new BadRequestException({ message: 'El cliente no tiene un NIF válido' }),
      );
    try {
      await app
        .get(FirstInvoiceService)
        .issueIfMissing(owner.tenantId, contract.body.id, customerId);
    } finally {
      spy.mockRestore();
    }

    const note = await adminClient.notification.findFirstOrThrow({
      where: { tenantId: owner.tenantId, type: 'invoice.first_invoice_failed' },
    });
    expect(note.body).toContain('El cliente no tiene un NIF válido');
    expect(note.link).toMatch(/^\/invoices\//);
  });

  it('con envío real a la AEAT, la reserva online exige un DNI o NIE válido', async () => {
    const owner = await registerVerifiedUser(app, 'billbooknif');
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    const facility = avail.body.facilities[0];
    const body = (documentNumber: string) => ({
      facilityId: facility.id,
      unitTypeId: facility.unitTypes[0].id,
      startDate: '2026-03-01',
      customer: {
        firstName: 'Nora',
        lastName: 'Vidal',
        email: `nora.${Date.now()}@e2e.local`,
        phone: '600111222',
        documentNumber,
      },
    });

    const config = app.get(ConfigService);
    const original = config.get.bind(config);
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation(((key: string, opts?: unknown) =>
        key === 'AEAT_MODE' ? 'sandbox' : original(key, opts as never)) as never);
    try {
      const bad = await http().post(`/public/move-in/book/${owner.slug}`).send(body('12345678A'));
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('invalid_tax_id');
    } finally {
      spy.mockRestore();
    }
    // Sin envío real (stub) el mismo documento se admite.
    const ok = await http().post(`/public/move-in/book/${owner.slug}`).send(body('12345678A'));
    expect(ok.status).toBe(201);
  });
});
