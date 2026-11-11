import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { futureCollectionDate } from './helpers/platform-sepa';
import { scopedUser } from './helpers/scoped-user';
import { reachCollectionDate } from './helpers/sepa';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CREDITOR_IBAN = 'ES9121000418450200051332';
const DEBTOR_IBAN = 'ES7921000813610123456789';
const OTHER_IBAN = 'ES6621000418401234567891';

interface PrenoticeRow {
  itemId: string;
  invoiceId: string;
  itemStatus: string;
  endToEndId: string;
  mandateReference: string;
}

/**
 * Revisión de las remesas SEPA: de toda la empresa, solo facturas, avisa de lo
 * que no entra, no se registra antes del cargo, el cobro lleva la fecha del
 * cargo y no se deshace desde la factura, un adeudo se marca devuelto desde la
 * remesa y otra cuenta no cancela el mandato firmado hasta que se firma.
 */
describe('Remesas SEPA: revisión (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let owner: { slug: string; accessToken: string; tenantId: string };
  const http = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${owner.accessToken}` });

  async function issued(customerId: string, unitPrice = 100): Promise<string> {
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice });
    await http().post(`/invoices/${id}/issue`).set(auth()).expect(200);
    return id;
  }

  async function customerWithMandate(): Promise<{ customerId: string; mandateId: string }> {
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `sepa-rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`,
    });
    const m = await http()
      .post('/sepa/mandates')
      .set(auth())
      .send({ customerId, iban: DEBTOR_IBAN, signedOutside: true, signedAt: '2026-01-15' })
      .expect(201);
    return { customerId, mandateId: m.body.id as string };
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    owner = await registerVerifiedUser(app, 'separev');
    await setTenantPlan(owner.slug, 'pro');
    await ensureDefaultSeries(app, owner.accessToken);
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({
        creditorName: 'Trasteros SL',
        creditorId: 'ES97ZZZB12345678',
        creditorIban: CREDITOR_IBAN,
        creditorAddress: 'Calle Mayor 1',
        creditorPostalCode: '28001',
        creditorCity: 'Madrid',
        enabled: true,
      })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('la remesa es de toda la empresa; los mandatos, de los inquilinos que ve cada uno', async () => {
    const { customerId: free } = await customerWithMandate();
    const outsider = await createCustomer(app, owner.accessToken, {
      email: `sepa-out-${Date.now()}@e2e.local`,
    });
    const { facilityId: facilityB } = await signedContractFor(app, owner.accessToken, {
      id: outsider,
    });
    const facilityA = await http()
      .post('/facilities')
      .set(auth())
      .send({ name: 'Local A', city: 'Madrid', postalCode: '28001' })
      .expect(201);
    expect(facilityB).not.toBe(facilityA.body.id);
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [facilityA.body.id as string],
      tag: 'sepascope',
    });
    const denied = await http().get('/sepa/remittances').set(scoped).expect(403);
    expect(denied.body.code).toBe('company_wide_only');
    await http().post('/sepa/remittances/preview').set(scoped).expect(403);
    // Un inquilino sin contrato lo ve todo el equipo; uno de otro local, no.
    const visible = await http().get(`/sepa/mandates?customerId=${free}`).set(scoped).expect(200);
    expect(visible.body).toHaveLength(1);
    await http()
      .post('/sepa/mandates')
      .set(scoped)
      .send({
        customerId: outsider,
        iban: DEBTOR_IBAN,
        signedOutside: true,
        signedAt: '2026-01-15',
      })
      .expect(404);
    await http().get('/sepa/mandates?customerId=no-es-un-id').set(auth()).expect(400);
  });

  it('solo facturas, avisa de lo omitido y no se genera con SEPA apagado', async () => {
    const { customerId } = await customerWithMandate();
    const invoice = await issued(customerId);
    const receipt = await issued(customerId, 50);
    // Un justificante de fianza no se domicilia.
    await admin.invoice.update({ where: { id: receipt }, data: { kind: 'deposit_receipt' } });
    const preview = await http().post('/sepa/remittances/preview').set(auth()).expect(200);
    const ids = (preview.body.eligible as { invoiceId: string }[]).map((e) => e.invoiceId);
    expect(ids).toContain(invoice);
    expect(ids).not.toContain(receipt);
    const row = (preview.body.eligible as { invoiceId: string; prenoticeDays: number }[]).find(
      (e) => e.invoiceId === invoice,
    )!;
    expect(row.prenoticeDays).toBe(14);

    // Elegida pero cobrada por otra vía antes de generar: se dice que no entra.
    const paidMeanwhile = await issued(customerId, 10);
    await http()
      .post(`/invoices/${paidMeanwhile}/mark-paid`)
      .set(auth())
      .send({ amount: 12.1, methodType: 'cash' })
      .expect(200);
    const created = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({
        name: 'Remesa omitidas',
        collectionDate: futureCollectionDate(20),
        invoiceIds: [invoice, paidMeanwhile],
      })
      .expect(201);
    expect(created.body.itemCount).toBe(1);
    expect(created.body.omitted.map((o: { invoiceId: string }) => o.invoiceId)).toEqual([
      paidMeanwhile,
    ]);
    await http()
      .post(`/sepa/remittances/${created.body.id as string}/cancel`)
      .set(auth())
      .expect(200);

    // Con SEPA apagado no se genera aunque se llame al API.
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({ creditorName: 'Trasteros SL', creditorId: 'ES97ZZZB12345678', enabled: false })
      .expect(200);
    const off = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({ name: 'Apagada', collectionDate: futureCollectionDate(20) })
      .expect(400);
    expect(off.body.code).toBe('sepa_disabled');
    await http()
      .put('/sepa/settings')
      .set(auth())
      .send({ creditorName: 'Trasteros SL', creditorId: 'ES97ZZZB12345678', enabled: true })
      .expect(200);
  });

  it('el cobro lleva la fecha del cargo, no se deshace en la factura y se marca devuelto en la remesa', async () => {
    const { customerId } = await customerWithMandate();
    const invoice = await issued(customerId);
    const rem = await http()
      .post('/sepa/remittances')
      .set(auth())
      .send({
        name: 'Remesa cargo',
        collectionDate: futureCollectionDate(20),
        invoiceIds: [invoice],
      })
      .expect(201);
    const remId = rem.body.id as string;
    const resend = await http()
      .post(`/sepa/remittances/${remId}/prenotices/resend`)
      .set(auth())
      .expect(200);
    expect(typeof resend.body.resent).toBe('number');
    await reachCollectionDate(app, remId);
    await http().post(`/sepa/remittances/${remId}/confirm`).set(auth()).send({}).expect(200);

    const collectionDay = (
      await admin.sepaRemittance.findUniqueOrThrow({ where: { id: remId } })
    ).collectionDate
      .toISOString()
      .slice(0, 10);
    const item = await admin.sepaRemittanceItem.findFirstOrThrow({
      where: { remittanceId: remId },
    });
    expect(item.status).toBe('collected');
    const payment = await admin.payment.findUniqueOrThrow({ where: { id: item.paymentId! } });
    expect(payment.paidAt!.toISOString().slice(0, 10)).toBe(collectionDay);

    // Desde la factura no se deshace: se marca devuelto en la remesa.
    const activity = await http().get(`/invoices/${invoice}/activity`).set(auth()).expect(200);
    const row = (
      activity.body.payments as { id: string; editable: boolean; lockedReason: string | null }[]
    ).find((p) => p.id === payment.id)!;
    expect(row.editable).toBe(false);
    expect(row.lockedReason).toContain('remesa');
    const locked = await http()
      .post(`/invoices/${invoice}/payments/${payment.id}/undo`)
      .set(auth())
      .send({ reason: 'Prueba de bloqueo' })
      .expect(400);
    expect(locked.body.code).toBe('payment_locked');

    const prenotices = (
      await http().get(`/sepa/remittances/${remId}/prenotices`).set(auth()).expect(200)
    ).body as PrenoticeRow[];
    expect(prenotices[0]!.endToEndId).toBe(item.endToEndId);
    const returned = await http()
      .post(`/sepa/remittances/${remId}/items/${item.id}/return`)
      .set(auth())
      .send({ reason: 'AC04 cuenta cancelada' })
      .expect(200);
    expect(returned.body.returnedCount).toBe(1);
    const after = await admin.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect(after.status).not.toBe('paid');
    expect(Number(after.amountPaid)).toBe(0);
    const again = await http()
      .post(`/sepa/remittances/${remId}/items/${item.id}/return`)
      .set(auth())
      .send({})
      .expect(400);
    expect(again.body.code).toBe('item_not_collected');
    // Vuelve a poder ir en otra remesa.
    const preview = await http().post('/sepa/remittances/preview').set(auth()).expect(200);
    expect(
      (preview.body.eligible as { invoiceId: string }[]).some((e) => e.invoiceId === invoice),
    ).toBe(true);
  });

  it('otra cuenta no cancela el mandato firmado hasta que se firma', async () => {
    const { customerId, mandateId } = await customerWithMandate();
    const next = await http()
      .post('/sepa/mandates')
      .set(auth())
      .send({ customerId, iban: OTHER_IBAN })
      .expect(201);
    expect(next.body.status).toBe('replacing');
    const current = await admin.sepaMandate.findUniqueOrThrow({ where: { id: mandateId } });
    expect(current.status).toBe('active');

    const token = (next.body.signingUrl as string).split('/sepa-mandate/')[1]!;
    await http()
      .post(`/public/sepa-mandates/${token}/sign`)
      .send({
        signerName: 'Ana Titular',
        address: 'Calle Falsa 123',
        postalCode: '28002',
        city: 'Madrid',
        country: 'ES',
        place: 'Madrid',
        method: 'typed',
        typedSignature: 'Ana Titular',
        accept: true,
      })
      .expect(200);
    const old = await admin.sepaMandate.findUniqueOrThrow({ where: { id: mandateId } });
    expect(old.status).toBe('cancelled');
    const signed = await admin.sepaMandate.findUniqueOrThrow({ where: { id: next.body.id } });
    expect(signed.status).toBe('active');
    expect(signed.signatureStatus).toBe('signed');
    // Volver a abrir el enlace dice que ya está firmado (antes: «enlace no válido»).
    const view = await http().get(`/public/sepa-mandates/${token}`).expect(200);
    expect(view.body.signed).toBe(true);
    expect(view.body.brand.tenantSlug).toBe(owner.slug);
  });
});
