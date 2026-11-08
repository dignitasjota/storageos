import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SignaturesService } from '../src/modules/move-in/signatures.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Correos de una reserva online: la primera factura no se avisa hasta que se
 * paga (llega con «Pago recibido») y, si la reserva caduca sin pagar, al
 * inquilino se le dice y se le ofrece volver a reservar.
 */
describe('Reserva online: correos de la factura y de la caducidad (e2e)', () => {
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

  async function book(slug: string, email: string, sign: boolean) {
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-05-01',
        customer: {
          phone: '600000000',
          documentNumber: '12345678Z',
          firstName: 'Ana',
          lastName: 'Ruiz',
          email,
        },
      });
    expect(booking.status).toBe(201);
    if (sign) {
      await request(app.getHttpServer())
        .post(`/public/move-in/sign/${booking.body.signingToken}`)
        .send({
          signerName: 'Ana Ruiz',
          method: 'typed',
          typedSignature: 'Ana Ruiz',
          accept: true,
          generalTermsHash: await generalTermsHash(app, booking.body.signingToken),
        })
        .expect(201);
    }
    const contract = await db.contract.findUniqueOrThrow({
      where: { id: booking.body.contractId as string },
      select: { id: true, customerId: true },
    });
    return {
      contractId: contract.id,
      customerId: contract.customerId,
      facilityId: facility.id as string,
      unitTypeId: facility.unitTypes[0].id as string,
    };
  }

  async function waitForComm(where: { invoiceId?: string; customerId?: string }, source: string) {
    for (let i = 0; i < 40; i++) {
      const comm = await db.communication.findFirst({ where: { ...where, source } });
      if (comm) return comm;
      await pause(250);
    }
    throw new Error(`no llegó el aviso ${source}`);
  }

  it('la primera factura no se avisa hasta pagarla; las demás facturas sí', async () => {
    const owner = await registerVerifiedUser(app, 'obemail');
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const { contractId, customerId } = await book(owner.slug, `obe-${Date.now()}@e2e.local`, true);

    const invoice = await db.invoice.findFirstOrThrow({
      where: { contractId, kind: 'invoice' },
      select: { id: true, status: true, total: true },
    });
    expect(invoice.status).toBe('issued');
    // Los avisos salen en segundo plano: se deja margen antes de mirar.
    await pause(1500);
    expect(
      await db.communication.count({
        where: { invoiceId: invoice.id, source: 'customer_email.invoice_issued' },
      }),
    ).toBe(0);

    // Al pagarla le llega el justificante con el enlace de la factura.
    const paid = await request(app.getHttpServer())
      .post(`/invoices/${invoice.id}/mark-paid`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ amount: Number(invoice.total), methodType: 'bank_transfer' });
    expect([200, 201]).toContain(paid.status);
    const receipt = await waitForComm({ invoiceId: invoice.id }, 'customer_email.payment_received');
    expect(receipt.bodyText).toContain('/v1/public/invoices/');

    // Una factura que no es la de la reserva se avisa al emitirse, como siempre.
    const other = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        customerId,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/invoices/${other.body.id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    await waitForComm({ invoiceId: other.body.id }, 'customer_email.invoice_issued');
  });

  it('si caduca sin pagar, se le avisa con el enlace para volver a reservar (firmada o no)', async () => {
    const owner = await registerVerifiedUser(app, 'obexpire');
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const signed = await book(owner.slug, `obs-${Date.now()}@e2e.local`, true);
    const unsigned = await book(owner.slug, `obu-${Date.now()}@e2e.local`, false);

    await db.contract.updateMany({
      where: { id: { in: [signed.contractId, unsigned.contractId] } },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });
    const res = await app.get(SignaturesService, { strict: false }).expireUnpaidBookings();
    expect(res.cancelled).toBeGreaterThanOrEqual(2);

    // Firmada y sin pagar: su factura queda anulada (rectificada) y se le dice.
    const signedComm = await waitForComm(
      { customerId: signed.customerId },
      'customer_email.booking_expired',
    );
    expect(signedComm.subject).toContain('se ha cancelado');
    expect(signedComm.bodyText).toContain('No hemos recibido el pago de tu reserva');
    expect(signedComm.bodyText).toContain('la reserva y su factura quedan anuladas');
    expect(signedComm.bodyText).toContain(
      `/book/${owner.slug}?facilityId=${signed.facilityId}&unitTypeId=${signed.unitTypeId}`,
    );
    expect(signedComm.contractId).toBe(signed.contractId);
    const voided = await db.invoice.findFirstOrThrow({
      where: { contractId: signed.contractId, kind: 'invoice', rectifiesInvoiceId: null },
      select: { status: true },
    });
    expect(voided.status).toBe('rectified');

    // Sin firmar: no hubo factura.
    const unsignedComm = await waitForComm(
      { customerId: unsigned.customerId },
      'customer_email.booking_expired',
    );
    expect(unsignedComm.bodyText).toContain('no se terminó a tiempo');
    expect(unsignedComm.bodyText).not.toContain('factura');

    // Con el aviso apagado en Configuración → Correo, no sale.
    await request(app.getHttpServer())
      .patch('/settings/tenant/customer-emails')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ booking_expired: false })
      .expect(200);
    const third = await book(owner.slug, `obt-${Date.now()}@e2e.local`, true);
    await db.contract.update({
      where: { id: third.contractId },
      data: { firstPaymentDeadline: new Date(Date.now() - 1000) },
    });
    await app.get(SignaturesService, { strict: false }).expireUnpaidBookings();
    await pause(1500);
    expect(
      await db.communication.count({
        where: { customerId: third.customerId, source: 'customer_email.booking_expired' },
      }),
    ).toBe(0);
  });
});
