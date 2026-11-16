import request from 'supertest';

import { InvoicePdfService } from '../src/modules/billing/invoice-pdf.service';
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

  it('el detalle en PDF sin número: desde el correo, el panel y el área de clientes; y se reenvía', async () => {
    // Sin navegador en las pruebas: se captura el HTML que iría al PDF.
    const pdf = app.get(InvoicePdfService);
    const pages: string[] = [];
    const browser = jest
      .spyOn(pdf as unknown as { getBrowser: () => Promise<unknown> }, 'getBrowser')
      .mockResolvedValue({
        newPage: async () => ({
          setContent: async (html: string) => {
            pages.push(html);
          },
          pdf: async () => Buffer.from('%PDF-1.4 primer pago'),
          close: async () => undefined,
        }),
      });
    try {
      const owner = await registerVerifiedUser(app, 'fppdf');
      const auth = { Authorization: `Bearer ${owner.accessToken}` };
      await ensureDefaultSeries(app, owner.accessToken);
      const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
      const email = `fp-pdf-${Date.now()}@e2e.local`;
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
      const firstToken = url.slice(url.indexOf('/sign/') + '/sign/'.length);
      const signed = await http()
        .post(`/public/move-in/sign/${firstToken}`)
        .send(await signBody(firstToken))
        .expect(201);
      const invoice = await admin.invoice.findFirstOrThrow({
        where: { contractId, kind: 'invoice' },
      });
      const receipt = await admin.invoice.findFirstOrThrow({
        where: { contractId, kind: 'deposit_receipt' },
      });
      const expected = Math.round((Number(invoice.total) + 40) * 100) / 100;

      // El correo lleva el enlace del PDF; abrirlo da el detalle sin número.
      await commsOf(contractId, 'customer_email.first_payment_pending');
      const mail = await waitForEmail(email, { subjectIncludes: 'falta el primer pago' });
      const pdfLink = /Descargar el detalle del pago en PDF: (\S+)/.exec(mail.Text)?.[1];
      expect(pdfLink).toContain(`/v1/public/invoices/${invoice.id}.`);
      const fromMail = await http()
        .get(new URL(pdfLink!).pathname)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(fromMail.headers['content-type']).toContain('application/pdf');
      expect(fromMail.headers['content-disposition']).toContain('primer-pago-');
      expect((fromMail.body as Buffer).toString()).toContain('%PDF');
      const html = pages.at(-1)!;
      expect(html).toContain('<h1>Primer pago</h1>');
      expect(html).not.toContain('DRAFT-');
      expect(html).toMatch(/Fianza \(sin IVA\)<\/span><span class="num">40,00\s€/);
      expect(html).toContain(`${expected.toLocaleString('es-ES', { minimumFractionDigits: 2 })}`);

      // Panel: «Descargar» lleva al mismo detalle (también desde la fianza).
      const panel = await http().get(`/invoices/${invoice.id}/signed-pdf`).set(auth).expect(200);
      expect(panel.body.url).toBe(pdfLink);
      const fromReceipt = await http()
        .get(`/invoices/${receipt.id}/signed-pdf`)
        .set(auth)
        .expect(200);
      expect(fromReceipt.body.url).toContain(`/v1/public/invoices/${receipt.id}.`);

      // Área de clientes: el primer pago tiene su PDF.
      const portal = { Authorization: `Bearer ${signed.body.portalToken as string}` };
      const mine = await http().get('/portal/me/invoices').set(portal).expect(200);
      expect(
        (mine.body as { id: string; hasPdf: boolean }[]).find((i) => i.id === invoice.id),
      ).toMatchObject({ hasPdf: true });
      const fromPortal = await http()
        .get(`/portal/me/invoices/${invoice.id}/signed-pdf`)
        .set(portal)
        .expect(200);
      expect(fromPortal.body.url).toBe(pdfLink);

      // Reenviar desde el panel: el correo con un enlace nuevo para pagar.
      const resent = await http()
        .post(`/invoices/${invoice.id}/send`)
        .set(auth)
        .send({})
        .expect(200);
      expect(resent.body.recipient).toBe(email);
      const comm = await admin.communication.findUniqueOrThrow({
        where: { id: resent.body.communicationId as string },
      });
      expect(comm).toMatchObject({ source: 'invoice.sent', invoiceId: invoice.id, contractId });
      expect(comm.subject).toContain('Recordatorio: falta el primer pago');
      const again = await waitForEmail(email, { subjectIncludes: 'Recordatorio: falta el primer' });
      const newToken = /Pagar ahora: \S+\/sign\/(\S+)/.exec(again.Text)?.[1];
      expect(newToken).toBeDefined();
      expect(newToken).not.toBe(firstToken);
      expect(again.Text).toContain(pdfLink);
      const view = await http().get(`/public/move-in/sign/${newToken}`).expect(200);
      expect(view.body).toMatchObject({ alreadySigned: true, paymentPending: true });
      const old = await http().get(`/public/move-in/sign/${firstToken}`);
      expect(old.status).not.toBe(200);
      const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(contract.signingTokenExpiresAt!.getTime()).toBe(
        contract.firstPaymentDeadline!.getTime(),
      );

      // Desde la fianza también se reenvía (el correo es del primer pago entero).
      const viaReceipt = await http()
        .post(`/invoices/${receipt.id}/send`)
        .set(auth)
        .send({ email: `otra-${Date.now()}@e2e.local` })
        .expect(200);
      const comm2 = await admin.communication.findUniqueOrThrow({
        where: { id: viaReceipt.body.communicationId as string },
      });
      expect(comm2.invoiceId).toBe(invoice.id);

      // Ampliar el plazo deja el enlace para pagar valiendo hasta el nuevo.
      const extended = await http()
        .post(`/contracts/${contractId}/payment-deadline`)
        .set(auth)
        .send({ days: 3, notifyCustomer: false })
        .expect(200);
      const afterExtend = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
      expect(afterExtend.signingTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        new Date(extended.body.paymentDeadline as string).getTime(),
      );

      // Con el plazo vencido no se reenvía: hay que ampliarlo antes.
      await admin.contract.update({
        where: { id: contractId },
        data: { firstPaymentDeadline: new Date(Date.now() - 60_000) },
      });
      const late = await http().post(`/invoices/${invoice.id}/send`).set(auth).send({}).expect(409);
      expect(late.body.code).toBe('payment_deadline_passed');
    } finally {
      browser.mockRestore();
    }
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
