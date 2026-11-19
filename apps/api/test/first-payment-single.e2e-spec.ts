import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { PortalService } from '../src/modules/portal/portal.service';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * El primer pago de un contrato (factura del alquiler + su fianza) es un solo
 * pago: se cobran juntas, se avisa una vez y el panel lo enseña como pendiente.
 */
describe('Primer pago en un solo pago (e2e)', () => {
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

  /** Contrato del panel con fianza, firmado por enlace (primer pago sin cobrar). */
  async function signedWithDeposit(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${suffix}-${Date.now()}@e2e.local`,
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
    const contractNumber = created.body.contractNumber as string;
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
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
    });
    const deposit = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'deposit_receipt' },
    });
    return {
      owner,
      auth,
      tenantId: owner.tenantId,
      customerId,
      contractId,
      contractNumber,
      token,
      invoice,
      deposit,
      total: Math.round((Number(invoice.total) + 40) * 100) / 100,
    };
  }

  it('el panel lo enseña como pendiente de pago, con la fianza y en «Hoy»', async () => {
    const s = await signedWithDeposit('fpsingle');

    // Filtro «Pendiente de pago»: la factura sin número con su fianza.
    const awaiting = await http()
      .get('/invoices/page')
      .query({ awaitingPayment: 'true' })
      .set(s.auth)
      .expect(200);
    const row = (
      awaiting.body.items as { id: string; bundledDeposit: { amountPending: number } | null }[]
    ).find((i) => i.id === s.invoice.id);
    expect(row?.bundledDeposit).toMatchObject({ amountPending: 40 });
    expect((awaiting.body.items as { kind: string }[]).every((i) => i.kind === 'invoice')).toBe(
      true,
    );

    // Se encuentra por el número del contrato (aún no tiene número propio).
    const found = await http()
      .get('/invoices/page')
      .query({ search: s.contractNumber })
      .set(s.auth)
      .expect(200);
    expect((found.body.items as { id: string }[]).map((i) => i.id)).toContain(s.invoice.id);

    // Lo pendiente cuenta el primer pago (factura y fianza).
    const totals = await http()
      .get('/invoices/totals')
      .query({ customerId: s.customerId })
      .set(s.auth)
      .expect(200);
    expect(totals.body.pending).toBe(s.total);
    // Con el filtro «Pendiente de pago» (solo facturas) también cuenta la fianza.
    const awaitingTotals = await http()
      .get('/invoices/totals')
      .query({ customerId: s.customerId, awaitingPayment: 'true' })
      .set(s.auth)
      .expect(200);
    expect(awaitingTotals.body.pending).toBe(s.total);

    // «Hoy»: primeros pagos pendientes, con el total y el plazo.
    const today = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today.body.firstPaymentsPending.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: s.invoice.id, amount: s.total, linkId: s.contractId }),
      ]),
    );
  });

  it('pagar la fianza suelta cobra la factura con ella', async () => {
    const s = await signedWithDeposit('fphead');
    const portal = app.get(PortalService);
    // La fianza que va con una factura pendiente se cobra con la factura.
    expect(await portal.paymentHead(s.tenantId, s.customerId, s.deposit.id)).toBe(s.invoice.id);
    expect(await portal.paymentHead(s.tenantId, s.customerId, s.invoice.id)).toBe(s.invoice.id);
    // De otro inquilino, no.
    expect(await portal.paymentHead(s.tenantId, crypto.randomUUID(), s.deposit.id)).toBe(
      s.deposit.id,
    );

    // El área de clientes ve la factura con lo que suma la fianza.
    const pay = await http().post(`/public/move-in/sign/${s.token}/payment`).expect(200);
    const list = await http()
      .get('/portal/me/invoices')
      .set('Authorization', `Bearer ${pay.body.portalToken as string}`)
      .expect(200);
    const head = (list.body as { id: string; bundledReceiptPending: number }[]).find(
      (i) => i.id === s.invoice.id,
    );
    expect(head?.bundledReceiptPending).toBe(40);
    const fz = (list.body as { id: string; paidWithInvoiceId: string | null }[]).find(
      (i) => i.id === s.deposit.id,
    );
    expect(fz?.paidWithInvoiceId).toBe(s.invoice.id);
  });

  it('«Registrar cobro» con la fianza: las dos pagadas y un solo aviso por el total', async () => {
    const s = await signedWithDeposit('fpmark');
    const paid = await http()
      .post(`/invoices/${s.invoice.id}/mark-paid`)
      .set(s.auth)
      .send({
        amount: Number(s.invoice.total),
        methodType: 'bank_transfer',
        includeBundledDeposit: true,
      })
      .expect((r) => expect(r.status).toBeLessThan(300));
    expect(paid.body.status).toBe('paid');
    expect(paid.body.invoiceNumber).not.toMatch(/^DRAFT-/);
    const fz = await admin.invoice.findUniqueOrThrow({ where: { id: s.deposit.id } });
    expect(fz.status).toBe('paid');

    // Un solo «Pago recibido», por el total (no otro de «Fianza recibida»).
    let received: { bodyText: string | null }[] = [];
    for (let i = 0; i < 40; i++) {
      received = await admin.communication.findMany({
        where: { customerId: s.customerId, source: 'customer_email.payment_received' },
      });
      if (received.length > 0) break;
      await sleep(250);
    }
    await sleep(1000);
    received = await admin.communication.findMany({
      where: { customerId: s.customerId, source: 'customer_email.payment_received' },
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.bodyText).toContain(
      s.total.toLocaleString('es-ES', { minimumFractionDigits: 2 }),
    );
  });
});
