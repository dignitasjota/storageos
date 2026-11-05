import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Inquilinos: datos, documentos, cobro, borrado, alcance y duplicados. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('Revisión de Inquilinos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  async function setup(slug: string) {
    const owner = await registerVerifiedUser(app, slug);
    return { owner, auth: { Authorization: `Bearer ${owner.accessToken}` } };
  }

  it('edita los datos validando nombre y documento', async () => {
    const { owner, auth } = await setup('cus-edit');
    const id = await createCustomer(app, owner.accessToken);
    const noName = await http().patch(`/customers/${id}`).set(auth).send({ firstName: '' });
    expect(noName.status).toBe(400);
    expect(noName.body.code).toBe('customer_name_required');
    const bad = await http()
      .patch(`/customers/${id}`)
      .set(auth)
      .send({ documentType: 'DNI', documentNumber: '12345678A' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_tax_id');
    const ok = await http()
      .patch(`/customers/${id}`)
      .set(auth)
      .send({ documentType: 'DNI', documentNumber: '12345678z', address: 'Calle Mayor 1' })
      .expect(200);
    expect(ok.body.documentNumber).toBe('12345678Z');
    expect(ok.body.address).toBe('Calle Mayor 1');
    // Un pasaporte no se comprueba.
    await http()
      .patch(`/customers/${id}`)
      .set(auth)
      .send({ documentType: 'Pasaporte', documentNumber: 'AB-1' })
      .expect(200);
  });

  it('avisa de duplicados por email, teléfono y documento', async () => {
    const { owner, auth } = await setup('cus-dup');
    const a = await createCustomer(app, owner.accessToken, { email: 'dup@example.com' });
    await http().patch(`/customers/${a}`).set(auth).send({ phone: '600 111 222' }).expect(200);
    const byEmail = await http()
      .get('/customers/duplicates')
      .set(auth)
      .query({ email: 'DUP@example.com' })
      .expect(200);
    expect(byEmail.body[0].id).toBe(a);
    expect(byEmail.body[0].matches).toEqual(['email']);
    const byPhone = await http()
      .get('/customers/duplicates')
      .set(auth)
      .query({ phone: '+34600111222' })
      .expect(200);
    expect(byPhone.body[0].matches).toEqual(['phone']);
    const self = await http()
      .get('/customers/duplicates')
      .set(auth)
      .query({ email: 'dup@example.com', excludeId: a })
      .expect(200);
    expect(self.body).toHaveLength(0);
  });

  it('no borra con reservas, y con deuda pide confirmación', async () => {
    const { owner, auth } = await setup('cus-del');
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const id = await createCustomer(app, owner.accessToken);
    const r = await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId: unitIds[0],
        customerId: id,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 3 * DAY).toISOString(),
      })
      .expect(201);
    const blocked = await http().delete(`/customers/${id}`).set(auth).expect(409);
    expect(blocked.body.code).toBe('customer_has_reservations');
    await http().post(`/reservations/${r.body.id}/cancel`).set(auth).send({}).expect(200);
    const inv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F1',
        customerId: id,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
        verifactuMode: 'verifactu',
      })
      .expect(201);
    await http().post(`/invoices/${inv.body.id}/issue`).set(auth).send({}).expect(200);
    const debt = await http().delete(`/customers/${id}`).set(auth).expect(409);
    expect(debt.body.code).toBe('customer_has_debt');
    expect(debt.body.details.amount).toBe(12.1);
    await http().delete(`/customers/${id}`).set(auth).query({ confirmDebt: '1' }).expect(204);
    await http().get(`/customers/${id}`).set(auth).expect(404);
  });

  it('la lista cuenta como deuda lo vencido sin marcar y no da por bueno un mandato sin firmar', async () => {
    const { owner, auth } = await setup('cus-debt');
    await ensureDefaultSeries(app, owner.accessToken);
    const id = await createCustomer(app, owner.accessToken);
    const tenant = await db.customer.findUniqueOrThrow({ where: { id } });
    const inv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F1',
        customerId: id,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
        verifactuMode: 'verifactu',
      })
      .expect(201);
    await http().post(`/invoices/${inv.body.id}/issue`).set(auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: inv.body.id as string },
      data: { dueDate: new Date(isoDay(-3)) },
    });
    await db.sepaMandate.create({
      data: {
        tenantId: tenant.tenantId,
        customerId: id,
        reference: `MND-${Date.now()}`,
        ibanEncrypted: 'x',
        ibanLast4: '1332',
        signedAt: new Date(),
        signatureStatus: 'pending',
      },
    });
    const list = await http().get('/customers/overview').set(auth).expect(200);
    const row = (list.body as { id: string; overdue: number; payVia: string | null }[]).find(
      (c) => c.id === id,
    );
    expect(row?.overdue).toBe(12.1);
    expect(row?.payVia).toBeNull();
    const account = await http().get(`/customers/${id}/account`).set(auth).expect(200);
    expect(account.body.overdue.amount).toBe(12.1);
    expect(account.body.payVia).toBeNull();
  });

  it('quien solo ve un local no ve inquilinos de otro, pero sí los que no tienen contrato', async () => {
    const { owner, auth } = await setup('cus-scope');
    const a = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const b = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const inA = await createCustomer(app, owner.accessToken);
    const inB = await createCustomer(app, owner.accessToken);
    const free = await createCustomer(app, owner.accessToken);
    for (const [customerId, unitId] of [
      [inA, a.unitIds[0]],
      [inB, b.unitIds[0]],
    ]) {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, startDate: isoDay(-5), priceMonthly: 50 })
        .expect(201);
      await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    }
    // Una factura de un trastero del otro local: su deuda no se ve con alcance.
    await ensureDefaultSeries(app, owner.accessToken);
    const otherInv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F1',
        customerId: inA,
        contractId: (await db.contract.findFirstOrThrow({ where: { customerId: inB } })).id,
        items: [{ description: 'Otro local', quantity: 1, unitPrice: 10, taxRate: 21 }],
        verifactuMode: 'verifactu',
      });
    expect(otherInv.status).toBe(201);
    await http().post(`/invoices/${otherInv.body.id}/issue`).set(auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: otherInv.body.id as string },
      data: { dueDate: new Date(isoDay(-3)) },
    });
    const email = `cus-staff-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(auth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await http()
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Staff Local', password: 'Secret123' })
      .expect(200);
    const users = await http().get('/users').set(auth).expect(200);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    await http()
      .patch(`/settings/users/${staff!.id}/facilities`)
      .set(auth)
      .send({ facilityIds: [a.facilityId] })
      .expect(204);
    const refreshed = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Secret123' })
      .expect(200);
    const scoped = { Authorization: `Bearer ${refreshed.body.accessToken}` };
    const list = await http().get('/customers/overview').set(scoped).expect(200);
    const ids = (list.body as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([inA, free]));
    expect(ids).not.toContain(inB);
    const rowA = (list.body as { id: string; overdue: number }[]).find((c) => c.id === inA);
    expect(rowA?.overdue).toBe(0);
    const ownerRow = (
      (await http().get('/customers/overview').set(auth).expect(200)).body as {
        id: string;
        overdue: number;
      }[]
    ).find((c) => c.id === inA);
    expect(ownerRow?.overdue).toBe(12.1);
    await http().get(`/customers/${inB}`).set(scoped).expect(404);
    await http().get(`/customers/${inB}/account`).set(scoped).expect(404);
    await http().get(`/customers/${inB}/documents`).set(scoped).expect(404);
    await http().get(`/customers/${inA}`).set(scoped).expect(200);
    const page = await http().get('/customers/page').set(scoped).expect(200);
    expect((page.body.items as { id: string }[]).map((c) => c.id)).not.toContain(inB);
  });

  it('envía el acceso al portal en lote', async () => {
    const { owner, auth } = await setup('cus-bulk');
    const a = await createCustomer(app, owner.accessToken);
    const b = await createCustomer(app, owner.accessToken);
    const res = await http()
      .post('/customers/bulk/portal-access')
      .set(auth)
      .send({ customerIds: [a, b] })
      .expect(200);
    expect(res.body).toEqual({ sent: 2, failed: 0 });
  });
});
