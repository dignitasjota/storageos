import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const TRANSFER_IBAN = 'ES9121000418450200051332';
const CUSTOMER_IBAN = 'ES7921000813610123456789';
const HOUR = 3_600_000;

/**
 * Transferencia, pago en el local y domiciliación SEPA: solo aparecen si el
 * tenant las activa; la transferencia manda el IBAN por correo y, con ella o
 * con el pago en el local, la reserva se guarda 24 h más y se avisa al equipo.
 */
describe('Formas de pago sin pasarela (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function bookAndSign(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const email = `off-${suffix}-${Date.now()}@e2e.local`;
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-01',
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Eva',
          lastName: 'Ruiz',
          email,
        },
      })
      .expect(201);
    const sign = await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({ signerName: 'Eva Ruiz', method: 'typed', typedSignature: 'Eva Ruiz', accept: true })
      .expect(201);
    const contractId = booking.body.contractId as string;
    const invoice = await admin.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
    });
    const portal = { Authorization: `Bearer ${sign.body.portalToken as string}` };
    return { owner, auth, portal, contractId, invoice, email };
  }

  it('transferencia y pago en el local: activables, IBAN por correo, +24 h y aviso al equipo', async () => {
    const { owner, auth, portal, contractId, invoice, email } = await bookAndSign('offtransfer');
    const http = app.getHttpServer();

    // Sin activar no aparecen ni se pueden elegir.
    const off = await request(http).get('/portal/me/payments/options').set(portal).expect(200);
    expect(off.body).toMatchObject({ bankTransfer: false, payAtFacility: false, sepaDebit: false });
    await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'bank_transfer' })
      .expect(400);

    // La transferencia exige el IBAN; la domiciliación, las remesas SEPA.
    const noIban = await request(http)
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ offlineTransferEnabled: true });
    expect(noIban.status).toBe(400);
    expect(noIban.body.code).toBe('transfer_iban_required');
    const noSepa = await request(http)
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ offlineSepaEnabled: true });
    expect(noSepa.body.code).toBe('sepa_not_enabled');

    const on = await request(http)
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ transferIban: TRANSFER_IBAN, offlineTransferEnabled: true, offlineCashEnabled: true })
      .expect(200);
    expect(on.body).toMatchObject({ offlineTransferEnabled: true, offlineCashEnabled: true });
    const opts = await request(http).get('/portal/me/payments/options').set(portal).expect(200);
    expect(opts.body).toMatchObject({ bankTransfer: true, payAtFacility: true, sepaDebit: false });

    const before = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    const chosen = await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'bank_transfer' })
      .expect(200);
    expect(chosen.body.emailSentTo).toBe(email);
    expect(chosen.body.mandateSigningUrl).toBeNull();
    const after = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(after.offlinePaymentMethod).toBe('bank_transfer');
    expect(after.firstPaymentDeadline!.getTime() - before.firstPaymentDeadline!.getTime()).toBe(
      24 * HOUR,
    );

    // El correo lleva el IBAN y el número de factura como concepto.
    const mail = await admin.communication.findFirstOrThrow({
      where: { invoiceId: invoice.id, source: 'offline_payment.transfer' },
    });
    expect(mail.recipient).toBe(email);
    expect(mail.bodyText).toContain('ES91 2100 0418 4502 0005 1332');
    expect(mail.bodyText).toContain(invoice.invoiceNumber!);

    // Aviso al equipo.
    const notice = await admin.notification.findFirst({
      where: { tenantId: owner.tenantId, type: 'invoice.offline_payment_chosen' },
    });
    expect(notice?.title).toContain('pagará por transferencia');

    // Cambiar a pagar en el local no vuelve a ampliar el plazo.
    await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'cash' })
      .expect(200);
    const again = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(again.offlinePaymentMethod).toBe('cash');
    expect(again.firstPaymentDeadline!.getTime()).toBe(after.firstPaymentDeadline!.getTime());

    // El panel propone esa forma y la marca pagada por transferencia.
    const dto = await request(http).get(`/invoices/${invoice.id}`).set(auth).expect(200);
    expect(dto.body.offlinePaymentMethod).toBe('cash');
    await request(http)
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set(auth)
      .send({ amount: Number(invoice.total), methodType: 'bank_transfer' })
      .expect(200);
    const payment = await admin.payment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(payment.methodType).toBe('bank_transfer');
  });

  it('domiciliación: alta del mandato y la reserva no caduca con el mandato firmado', async () => {
    const { owner, auth, portal, contractId, invoice } = await bookAndSign('offsepa');
    const http = app.getHttpServer();
    await setTenantPlan(owner.slug, 'pro');
    await request(http)
      .put('/sepa/settings')
      .set(auth)
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES97ZZZB12345678',
        creditorIban: TRANSFER_IBAN,
        enabled: true,
        creditorAddress: 'Calle Mayor 1',
        creditorPostalCode: '28001',
        creditorCity: 'Madrid',
      })
      .expect(200);
    await request(http)
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ offlineSepaEnabled: true })
      .expect(200);

    // Sin IBAN → 400.
    await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'sepa_debit' })
      .expect(400);
    const chosen = await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'sepa_debit', iban: CUSTOMER_IBAN })
      .expect(200);
    expect(chosen.body.mandateSigningUrl).toMatch(/\/sepa-mandate\//);

    const before = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    // La domiciliación no amplía el plazo.
    expect(before.offlinePaymentMethod).toBe('sepa_debit');

    // Firmado el mandato, aunque pase el plazo la reserva sigue.
    const mandate = await admin.sepaMandate.findFirstOrThrow({
      where: { tenantId: owner.tenantId, customerId: before.customerId, status: 'active' },
    });
    await admin.sepaMandate.update({
      where: { id: mandate.id },
      data: { signatureStatus: 'signed' },
    });
    await admin.contract.update({
      where: { id: contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - HOUR) },
    });
    await app.get(SignaturesService).expireUnpaidBookings();
    const kept = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(kept.status).not.toBe('cancelled');

    // Con el mandato firmado de esa cuenta, volver a elegirla no pide firmar otro.
    const reuse = await request(http)
      .post(`/portal/me/invoices/${invoice.id}/offline-payment`)
      .set(portal)
      .send({ method: 'sepa_debit', iban: CUSTOMER_IBAN })
      .expect(200);
    expect(reuse.body.mandateSigningUrl).toBeNull();
  });
});
