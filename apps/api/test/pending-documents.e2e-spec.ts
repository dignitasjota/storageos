import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

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
});
