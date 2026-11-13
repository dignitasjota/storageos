import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const DAY = 86_400_000;

/**
 * Documentos que no llegan a cobrarse: el justificante de fianza se anula sin
 * rectificativa, cancelar un contrato anula lo que tenía sin cobrar y la lista
 * de facturas puede ocultar lo cancelado.
 */
describe('Documentos sin cobrar (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  /** Reserva online firmada (con fianza) y sin pagar. */
  async function bookAndSign(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    await http()
      .patch(`/unit-types/${unitTypeId}`)
      .set(auth)
      .send({ defaultDepositAmount: 60 })
      .expect(200);
    const avail = await http().get(`/public/move-in/book/${owner.slug}/availability`);
    const facility = avail.body.facilities[0];
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Bea',
          lastName: 'López',
          email: `pend-${Date.now()}@e2e.local`,
        },
      })
      .expect(201);
    const signed = await http()
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({
        immediateStart: true,
        signerName: 'Bea López',
        method: 'typed',
        typedSignature: 'Bea López',
        accept: true,
        generalTermsHash: await generalTermsHash(app, booking.body.signingToken),
      })
      .expect(201);
    const contractId = booking.body.contractId as string;
    const docs = await admin.invoice.findMany({ where: { contractId } });
    return {
      auth,
      contractId,
      portalToken: signed.body.portalToken as string,
      invoice: docs.find((d) => d.kind === 'invoice')!,
      receipt: docs.find((d) => d.kind === 'deposit_receipt')!,
    };
  }

  it('el justificante de fianza sin cobrar se anula sin rectificativa', async () => {
    const { auth, contractId, receipt } = await bookAndSign('pendrcpt');

    const preview = await http()
      .get(`/invoices/${receipt.id}/cancel-preview`)
      .set(auth)
      .expect(200);
    expect(preview.body.action).toBe('cancel_receipt');

    await http()
      .post(`/invoices/${receipt.id}/cancel`)
      .set(auth)
      .send({ reason: 'No pagó la reserva' })
      .expect(200);
    const after = await admin.invoice.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.status).toBe('cancelled');
    const rectifications = await admin.invoice.count({
      where: { contractId, invoiceType: { in: ['R1', 'R2', 'R3', 'R4', 'R5'] } },
    });
    expect(rectifications).toBe(0);
  });

  it('la fianza espera al pago y, al registrar el cobro de la reserva, queda cobrada', async () => {
    const { auth, receipt } = await bookAndSign('pendpay');
    expect(receipt.status).toBe('draft');
    expect(receipt.issueOnPayment).toBe(true);

    // Cobrar la fianza en el local (efectivo) la deja hecha y pagada.
    await http()
      .post(`/contracts/${receipt.contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    const paid = await admin.invoice.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(paid.status).toBe('paid');
    expect(paid.issueDate).not.toBeNull();
  });

  it('cancelar el contrato anula lo que no se cobró y ya no se puede pagar', async () => {
    const { auth, contractId, invoice, receipt, portalToken } = await bookAndSign('pendctr');

    await http()
      .post(`/contracts/${contractId}/cancel`)
      .set(auth)
      .send({ reason: 'No va a pagar' })
      .expect(200);
    const docs = await admin.invoice.findMany({ where: { contractId } });
    expect(docs.find((d) => d.id === invoice.id)?.status).toBe('cancelled');
    expect(docs.find((d) => d.id === receipt.id)?.status).toBe('cancelled');
    // Ni número ni rectificativa.
    expect(docs.some((d) => d.invoiceType.startsWith('R'))).toBe(false);

    const pay = await http()
      .post(`/portal/me/invoices/${invoice.id}/charge`)
      .set({ Authorization: `Bearer ${portalToken}` })
      .send({});
    expect(pay.status).toBe(400);
  });

  it('la lista puede ocultar lo cancelado', async () => {
    const { auth, receipt, invoice } = await bookAndSign('pendlist');
    await http()
      .post(`/invoices/${receipt.id}/cancel`)
      .set(auth)
      .send({ reason: 'Fianza sin cobrar' })
      .expect(200);

    const all = await http().get('/invoices/page').set(auth).expect(200);
    const allIds = (all.body.items as { id: string }[]).map((i) => i.id);
    expect(allIds).toContain(receipt.id);

    const hidden = await http().get('/invoices/page?hideCancelled=true').set(auth).expect(200);
    const hiddenIds = (hidden.body.items as { id: string }[]).map((i) => i.id);
    expect(hiddenIds).not.toContain(receipt.id);
    expect(hiddenIds).toContain(invoice.id);

    // Pidiendo el estado «cancelada» se ve aunque se oculten.
    const cancelled = await http()
      .get('/invoices/page?status=cancelled&hideCancelled=true')
      .set(auth)
      .expect(200);
    expect((cancelled.body.items as { id: string }[]).map((i) => i.id)).toContain(receipt.id);

    const totals = await http().get('/invoices/totals?hideCancelled=true').set(auth).expect(200);
    expect(totals.body).toBeTruthy();
  });

  it('un contrato del panel firmado por enlace espera al pago y, si no paga, se cancela sin facturas', async () => {
    const owner = await registerVerifiedUser(app, 'pendlink');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      documentNumber: '12345678Z',
    });
    const created = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: madridToday(),
        priceMonthly: 50,
        billingCycle: 'monthly',
        depositAmount: 40,
      })
      .expect(201);
    const contractId = created.body.id as string;
    const sig = await http()
      .post(`/contracts/${contractId}/request-signature`)
      .set(auth)
      .expect(201);
    const url = sig.body.signingUrl as string;
    const token = url.slice(url.indexOf('/sign/') + '/sign/'.length);
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);

    // Como la reserva online: plazo para pagar y nada emitido hasta el cobro.
    const signed = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(signed.status).toBe('active');
    expect(signed.firstPaymentDeadline).not.toBeNull();
    const docs = await admin.invoice.findMany({ where: { contractId } });
    expect(docs.length).toBe(2);
    expect(docs.every((d) => d.status === 'draft' && d.issueOnPayment)).toBe(true);

    // Vence el plazo sin pagar: el contrato se cancela y no queda nada emitido.
    await admin.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();
    const after = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(after.status).toBe('cancelled');
    const left = await admin.invoice.findMany({ where: { contractId } });
    expect(left.every((d) => d.status === 'cancelled')).toBe(true);
    expect(left.some((d) => d.invoiceType.startsWith('R'))).toBe(false);
    expect(
      left.every((d) => d.invoiceNumber.startsWith('DRAFT-') || d.kind === 'deposit_receipt'),
    ).toBe(true);
  });

  it('la señal de una reserva se factura al cobrarse y, sin cobrar, se anula sin rectificativa', async () => {
    const owner = await registerVerifiedUser(app, 'pendsignal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken, {
      documentNumber: '12345678Z',
    });
    const reserve = async (unitId: string) => {
      const r = await http()
        .post('/reservations')
        .set(auth)
        .send({
          unitId,
          customerId,
          validFrom: new Date().toISOString(),
          validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
          depositAmount: 30,
          confirmImmediately: true,
        })
        .expect(201);
      const row = await admin.reservation.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(row.depositInvoiceId).not.toBeNull();
      const invoice = await admin.invoice.findUniqueOrThrow({
        where: { id: row.depositInvoiceId! },
      });
      expect(invoice.status).toBe('draft');
      expect(invoice.issueOnPayment).toBe(true);
      return { id: r.body.id as string, invoice };
    };

    // Cancelada sin pagar: la señal se anula sin número ni rectificativa.
    const first = await reserve(unitIds[0]!);
    await http()
      .post(`/reservations/${first.id}/cancel`)
      .set(auth)
      .send({ reason: 'No viene' })
      .expect(200);
    const dropped = await admin.invoice.findUniqueOrThrow({ where: { id: first.invoice.id } });
    expect(dropped.status).toBe('cancelled');
    expect(await admin.invoice.count({ where: { rectifiesInvoiceId: first.invoice.id } })).toBe(0);

    // Cobrada: se emite con su número y queda pagada.
    const second = await reserve(unitIds[1]!);
    await http()
      .post(`/invoices/${second.invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(second.invoice.total), methodType: 'cash' })
      .expect(200);
    const paid = await admin.invoice.findUniqueOrThrow({ where: { id: second.invoice.id } });
    expect(paid.status).toBe('paid');
    expect(paid.invoiceNumber).not.toMatch(/^DRAFT-/);
  });
});
