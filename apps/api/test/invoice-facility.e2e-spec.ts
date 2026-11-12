import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { InvoiceDto } from '@storageos/shared';

const LINE = [{ description: 'Prueba del TPV', quantity: 1, unitPrice: 0.83, taxRate: 21 }];

/**
 * Una factura sin contrato lleva su local: el único del negocio, o el que se
 * elige si hay varios (o ninguno: de toda la empresa). Así sale al filtrar la
 * lista por local y cuenta en la caja de ese local.
 */
describe('Local de las facturas sin contrato (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('con un solo local, la factura hecha a mano es de ese local y sale al filtrar', async () => {
    const owner = await registerVerifiedUser(app, 'invfac1');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    const res = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, items: LINE })
      .expect(201);
    const invoice = res.body as InvoiceDto;
    expect(invoice.facilityId).toBe(facilityId);
    expect(invoice.facilityName).toBeTruthy();
    expect(invoice.total).toBe(1);

    const filtered = await http()
      .get(`/invoices/page?facilityId=${facilityId}`)
      .set(auth)
      .expect(200);
    expect((filtered.body.items as InvoiceDto[]).map((i) => i.id)).toContain(invoice.id);

    // Duplicarla mantiene el local.
    const copy = await http().post(`/invoices/${invoice.id}/duplicate`).set(auth).expect(201);
    expect((copy.body as InvoiceDto).facilityId).toBe(facilityId);
  });

  it('con varios locales se elige el local, o ninguno; un local que no existe da 404', async () => {
    const owner = await registerVerifiedUser(app, 'invfac2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const a = await createFacilityWithUnits(app, owner.accessToken, { facilityName: 'Local A' });
    const b = await createFacilityWithUnits(app, owner.accessToken, { facilityName: 'Local B' });
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);

    // Sin indicar: no se sabe de cuál es, queda de toda la empresa.
    const none = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, items: LINE })
      .expect(201);
    expect((none.body as InvoiceDto).facilityId).toBeNull();

    const inB = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, facilityId: b.facilityId, items: LINE })
      .expect(201);
    expect(inB.body).toEqual(
      expect.objectContaining({ facilityId: b.facilityId, facilityName: 'Local B' }),
    );
    const company = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, facilityId: null, items: LINE })
      .expect(201);
    expect((company.body as InvoiceDto).facilityId).toBeNull();

    const listA = await http().get(`/invoices/page?facilityId=${a.facilityId}`).set(auth);
    const listB = await http().get(`/invoices/page?facilityId=${b.facilityId}`).set(auth);
    const ids = (r: request.Response) => (r.body.items as InvoiceDto[]).map((i) => i.id);
    expect(ids(listB)).toEqual([inB.body.id]);
    expect(ids(listA)).toEqual([]);

    const ghost = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, facilityId: '00000000-0000-4000-8000-000000000000', items: LINE });
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe('facility_not_found');
  });

  it('el cobro en efectivo de una factura sin contrato cuenta en la caja de su local', async () => {
    const owner = await registerVerifiedUser(app, 'invfac3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
    const customerId = await createCustomer(app, owner.accessToken);
    const created = await http()
      .post('/invoices')
      .set(auth)
      .send({ customerId, items: LINE })
      .expect(201);
    const id = created.body.id as string;
    await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${id}/mark-paid`)
      .set(auth)
      .send({ amount: 1, methodType: 'cash' })
      .expect(200);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
      new Date(),
    );
    const cash = await http()
      .get(`/cash/summary?date=${today}&facilityId=${facilityId}`)
      .set(auth)
      .expect(200);
    expect(cash.body.cash).toBe(1);
  });
});
