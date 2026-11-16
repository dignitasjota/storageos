import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Firmado por enlace, la factura del primer pago se emite al cobrarse (sin
 * número hasta entonces). Aun así el inquilino tiene que saber qué pagar: le
 * llega un correo con el desglose, el plazo y el botón, y el panel la enseña
 * en su ficha.
 */
describe('Primer pago pendiente (e2e)', () => {
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

  const signBody = async (token: string) => ({
    immediateStart: true,
    signerName: 'Ana García',
    method: 'typed',
    typedSignature: 'Ana García',
    accept: true,
    generalTermsHash: await generalTermsHash(app, token),
  });

  /** Comunicaciones de un contrato, cuando ya han salido. */
  async function commsOf(contractId: string, wanted: string) {
    for (let i = 0; i < 40; i++) {
      const rows = await admin.communication.findMany({ where: { contractId } });
      if (rows.some((r) => r.source === wanted)) return rows;
      await sleep(250);
    }
    return admin.communication.findMany({ where: { contractId } });
  }

  it('contrato del panel firmado por enlace: correo con lo que hay que pagar y ficha del inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'fppanel');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const email = `fp-panel-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, {
      email,
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
      .send(await signBody(token))
      .expect(201);

    // Factura sin número, pendiente de pago, y la fianza que va con ella.
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      include: { items: true },
    });
    expect(invoice).toMatchObject({ status: 'draft', issueOnPayment: true });
    expect(invoice.invoiceNumber).toMatch(/^DRAFT-/);
    const expected = Math.round((Number(invoice.total) + 40) * 100) / 100;

    // Un solo correo: el del primer pago (sustituye al de «contrato firmado»).
    const comms = await commsOf(contractId, 'customer_email.first_payment_pending');
    const sources = comms.map((c) => c.source);
    expect(sources).toContain('customer_email.first_payment_pending');
    expect(sources).not.toContain('customer_email.contract_signed');
    const comm = comms.find((c) => c.source === 'customer_email.first_payment_pending')!;
    expect(comm.invoiceId).toBe(invoice.id);
    expect(comm.subject).toContain('falta el primer pago');
    expect(comm.bodyText).toContain('Fianza: 40,00');
    expect(comm.bodyText).toContain(
      `Total: ${expected.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`,
    );
    // El enlace va tapado en el historial y completo en el correo.
    expect(comm.bodyText).toContain('/sign/[[SECRET-');
    const mail = await waitForEmail(email, { subjectIncludes: 'falta el primer pago' });
    const link = /\/sign\/([^\s"<]+)/.exec(mail.Text)?.[1];
    expect(link).toBe(token);
    const view = await http().get(`/public/move-in/sign/${link}`).expect(200);
    expect(view.body).toMatchObject({ alreadySigned: true, paymentPending: true });

    // El enlace vale hasta el plazo para pagar.
    const signed = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(signed.firstPaymentDeadline).not.toBeNull();
    expect(signed.signingTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
      signed.firstPaymentDeadline!.getTime(),
    );

    // El panel lo enseña en la ficha del inquilino.
    const account = await http().get(`/customers/${customerId}/account`).set(auth).expect(200);
    expect(account.body.firstPayment).toMatchObject({ invoiceId: invoice.id, amount: expected });
    expect(account.body.firstPayment.deadline).toBe(signed.firstPaymentDeadline!.toISOString());
    const list = await http().get('/invoices').query({ customerId }).set(auth).expect(200);
    expect(
      (list.body as { id: string; issueOnPayment: boolean }[]).find((i) => i.id === invoice.id),
    ).toMatchObject({ issueOnPayment: true });

    // Cobrado en el local (alquiler y fianza), deja de estar pendiente.
    await http()
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total), methodType: 'cash' })
      .expect(200);
    await http()
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    const after = await http().get(`/customers/${customerId}/account`).set(auth).expect(200);
    expect(after.body.firstPayment).toBeNull();
  }, 90_000);

  it('reserva online con un cupón que lo deja a 0 €: el correo de contrato firmado', async () => {
    const owner = await registerVerifiedUser(app, 'fpzero');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    await http()
      .post('/coupons')
      .set(auth)
      .send({ code: 'GRATIS', name: 'Gratis', discountType: 'percentage', discountValue: 100 })
      .expect(201);
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: madridToday(),
        months: 1,
        couponCode: 'GRATIS',
        customer: {
          firstName: 'Leo',
          lastName: 'Paz',
          email: `fp-zero-${Date.now()}@e2e.local`,
          phone: '600111222',
          documentNumber: '12345678Z',
        },
      })
      .expect(201);
    const token = booking.body.signingToken as string;
    const contractId = booking.body.contractId as string;
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send(await signBody(token))
      .expect(201);

    // Sin nada que pagar no se pide el pago: llega la confirmación de siempre.
    const comms = await commsOf(contractId, 'customer_email.contract_signed');
    const sources = comms.map((c) => c.source);
    expect(sources).toContain('customer_email.contract_signed');
    expect(sources).not.toContain('customer_email.first_payment_pending');
  }, 90_000);

  it('con el aviso del primer pago apagado, sale el de contrato firmado', async () => {
    const owner = await registerVerifiedUser(app, 'fpoff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const settings = await http()
      .patch('/settings/tenant/customer-emails')
      .set(auth)
      .send({ first_payment_pending: false })
      .expect(200);
    expect(settings.body.first_payment_pending).toBe(false);
    const booking = await http()
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId,
        unitTypeId,
        startDate: madridToday(),
        months: 1,
        customer: {
          firstName: 'Mar',
          lastName: 'Gil',
          email: `fp-off-${Date.now()}@e2e.local`,
          phone: '600111222',
          documentNumber: '12345678Z',
        },
      })
      .expect(201);
    const token = booking.body.signingToken as string;
    const contractId = booking.body.contractId as string;
    await http()
      .post(`/public/move-in/sign/${token}`)
      .send(await signBody(token))
      .expect(201);
    const comms = await commsOf(contractId, 'customer_email.contract_signed');
    expect(comms.map((c) => c.source)).toContain('customer_email.contract_signed');
  }, 90_000);
});
