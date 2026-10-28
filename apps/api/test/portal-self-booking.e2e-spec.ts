import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Portal: self-service de contratación de trastero (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  async function signPortalBooking(signingToken: string) {
    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${signingToken}`)
      .send({ signerName: 'Leo Paz', method: 'typed', typedSignature: 'Leo Paz', accept: true })
      .expect(201);
  }

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('el inquilino contrata un trastero disponible y se le emite la 1ª factura', async () => {
    const owner = await registerVerifiedUser(app, 'selfbook');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local SB', addressLine1: 'C/ T 1', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 60, defaultDepositAmount: 50 });
    const unitTypeId = unitType.body.id as string;
    const u1 = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId,
      unitTypeId,
      code: 'SB-001',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 60,
    });
    const u2 = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId,
      unitTypeId,
      code: 'SB-002',
      widthM: 2,
      depthM: 3,
      heightM: 2.5,
      basePriceMonthly: 80,
    });

    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Leo',
      lastName: 'Paz',
      email: 'leo-sb@x.com',
    });
    const customerId = customer.body.id as string;

    // Contrato activo en el local (para que el self-service le permita el local).
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: u1.body.id, priceMonthly: 60, startDate: '2026-01-01' });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({});

    // Sesión de portal.
    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const portalAuth = { Authorization: `Bearer ${consume.body.accessToken}` };

    // Contrata el trastero disponible SB-002.
    const booked = await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .set(portalAuth)
      .send({ unitId: u2.body.id });
    expect(booked.status).toBe(201);
    expect(booked.body.contractId).toBeTruthy();
    expect(booked.body.signingToken).toBeTruthy();
    expect(booked.body.portalToken).toBeTruthy();

    // Aún sin firmar: borrador y el trastero queda reservado mientras lo lee.
    const draft = await admin.contract.findUniqueOrThrow({ where: { id: booked.body.contractId } });
    expect(draft.status).toBe('draft');
    expect((await admin.unit.findUniqueOrThrow({ where: { id: u2.body.id } })).status).toBe(
      'reserved',
    );

    // Ve el contrato completo y lo firma (como en la reserva online).
    const view = await request(app.getHttpServer()).get(
      `/public/move-in/sign/${booked.body.signingToken}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.termsText).toContain('SB-002');
    await signPortalBooking(booked.body.signingToken);
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId: booked.body.contractId, kind: 'invoice' },
    });
    booked.body.invoiceId = invoice.id;

    // La factura aparece en sus facturas del portal (emitida).
    const invoices = await request(app.getHttpServer()).get('/portal/me/invoices').set(portalAuth);
    expect(invoices.body.some((i: { id: string }) => i.id === booked.body.invoiceId)).toBe(true);

    // SB-002 ya no está disponible.
    const available = await request(app.getHttpServer())
      .get('/portal/me/available-units')
      .set(portalAuth);
    expect(available.body.map((u: { code: string }) => u.code)).not.toContain('SB-002');

    // Sin sesión → 401.
    await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .send({ unitId: u2.body.id })
      .expect(401);
  });

  it('el cron cancela el booking impagado (libera la unidad + anula factura) y respeta el pagado', async () => {
    const owner = await registerVerifiedUser(app, 'bookexpire');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local BE', city: 'Madrid', postalCode: '28001' });
    const facilityId = facility.body.id as string;
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'M', defaultPriceMonthly: 50, defaultDepositAmount: 0 });
    const unitTypeId = unitType.body.id as string;
    const mkUnit = (code: string) =>
      request(app.getHttpServer()).post('/units').set(auth).send({
        facilityId,
        unitTypeId,
        code,
        widthM: 2,
        depthM: 2,
        heightM: 2,
        basePriceMonthly: 50,
      });
    const uBase = await mkUnit('BE-BASE');
    const uUnpaid = await mkUnit('BE-UNPAID');
    const uPaid = await mkUnit('BE-PAID');

    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Ana',
      lastName: 'Ríos',
      email: 'ana-be@x.com',
    });
    const customerId = customer.body.id as string;

    // Contrato base activo en el local.
    const base = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: uBase.body.id, priceMonthly: 50, startDate: '2026-01-01' });
    await request(app.getHttpServer()).post(`/contracts/${base.body.id}/sign`).set(auth).send({});

    const link = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set(auth);
    const token = new URL(link.body.url).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    const portalAuth = { Authorization: `Bearer ${consume.body.accessToken}` };

    // Dos bookings self-service.
    const bookUnpaid = await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .set(portalAuth)
      .send({ unitId: uUnpaid.body.id });
    const bookPaid = await request(app.getHttpServer())
      .post('/portal/me/contracts')
      .set(portalAuth)
      .send({ unitId: uPaid.body.id });
    expect(bookUnpaid.status).toBe(201);
    expect(bookPaid.status).toBe(201);
    for (const b of [bookUnpaid, bookPaid]) {
      await signPortalBooking(b.body.signingToken);
      b.body.invoiceId = (
        await admin.invoice.findFirstOrThrow({
          where: { contractId: b.body.contractId, kind: 'invoice' },
        })
      ).id;
    }

    // El booking «pagado» se marca como cobrado.
    await admin.invoice.update({
      where: { id: bookPaid.body.invoiceId },
      data: { status: 'paid', paidAt: new Date() },
    });
    // Ambos deadlines caducan.
    await admin.contract.updateMany({
      where: { id: { in: [bookUnpaid.body.contractId, bookPaid.body.contractId] } },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });

    const svc = app.get(SignaturesService, { strict: false });
    const res = await svc.expireUnpaidBookings();
    expect(res.cancelled).toBeGreaterThanOrEqual(1);

    // Impagado → contrato cancelado, unidad liberada, factura anulada.
    const cUnpaid = await admin.contract.findUnique({ where: { id: bookUnpaid.body.contractId } });
    expect(cUnpaid!.status).toBe('cancelled');
    const unitUnpaid = await admin.unit.findUnique({ where: { id: uUnpaid.body.id } });
    expect(unitUnpaid!.status).toBe('available');
    const invUnpaid = await admin.invoice.findUnique({ where: { id: bookUnpaid.body.invoiceId } });
    // Ya emitida: se anula con una rectificativa de abono (no se borra del libro de IVA).
    expect(invUnpaid!.status).toBe('rectified');
    expect(
      await admin.invoice.count({ where: { rectifiesInvoiceId: bookUnpaid.body.invoiceId } }),
    ).toBe(1);

    // Pagado → intacto (contrato sigue vivo, deadline limpiado).
    const cPaid = await admin.contract.findUnique({ where: { id: bookPaid.body.contractId } });
    expect(cPaid!.status).not.toBe('cancelled');
    expect(cPaid!.firstPaymentDeadline).toBeNull();
  });
});
