import { getQueueToken } from '@nestjs/bullmq';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const TEST_KEY = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7';

/** Mejoras del área de clientes (2026-10-28). */
describe('Portal del inquilino: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  async function portalSession(staffToken: string, customerId: string): Promise<string> {
    const link = await http()
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return consume.body.accessToken as string;
  }

  async function signed(staffToken: string, customerId: string, unitId: string) {
    const auth = { Authorization: `Bearer ${staffToken}` };
    const c = await http().post('/contracts').set(auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return c.body.id as string;
  }

  it('pide el cambio a un trastero libre de su local y el equipo lo ve con el precio', async () => {
    const owner = await registerVerifiedUser(app, 'pim-change');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Cambio' });
    const contractId = await signed(owner.accessToken, customerId, fac.unitIds[0]!);
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };

    // Uno de otro local no vale.
    const bad = await http()
      .post('/portal/me/unit-change-requests')
      .set(portal)
      .send({ contractId, targetUnitId: other.unitIds[0], desiredDate: '2026-12-01' });
    expect(bad.status).toBe(400);

    const ok = await http()
      .post('/portal/me/unit-change-requests')
      .set(portal)
      .send({ contractId, targetUnitId: fac.unitIds[1], desiredDate: '2026-12-01' })
      .expect(201);
    expect(ok.body.targetUnitCode).toBeTruthy();
    expect(ok.body.desiredDate).toBe('2026-12-01');

    const staff = await http().get('/unit-change-requests').set(auth).expect(200);
    const row = (staff.body as { id: string; targetUnitId: string | null }[]).find(
      (r) => r.id === ok.body.id,
    );
    expect(row?.targetUnitId).toBe(fac.unitIds[1]);
  });

  it('autorizados, pase de visita, contrato firmado y su local', async () => {
    const owner = await registerVerifiedUser(app, 'pim-visit');
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Visita' });
    const contractId = await signed(owner.accessToken, customerId, fac.unitIds[0]!);
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };

    const person = await http()
      .post('/portal/me/authorized-persons')
      .set(portal)
      .send({ fullName: 'Lucía Pérez', relationship: 'Hija', canAccess: true })
      .expect(201);
    const list = await http().get('/portal/me/authorized-persons').set(portal).expect(200);
    expect((list.body as unknown[]).length).toBe(1);

    const pass = await http()
      .post('/portal/me/access/visitor')
      .set(portal)
      .send({ authorizedPersonId: person.body.id })
      .expect(201);
    expect(pass.body.value).toMatch(/^\d+$/);
    const cred = await admin.accessCredential.findUniqueOrThrow({ where: { id: pass.body.id } });
    expect(cred.maxUses).toBe(1);
    expect(cred.allowedFacilityIds).toEqual([fac.facilityId]);
    expect(cred.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(cred.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 25 * 3_600_000);

    await http().delete(`/portal/me/authorized-persons/${person.body.id}`).set(portal).expect(204);

    const terms = await http()
      .get(`/portal/me/contracts/${contractId}/terms`)
      .set(portal)
      .expect(200);
    expect(terms.body).toHaveProperty('signedAt');

    const facilities = await http().get('/portal/me/facilities').set(portal).expect(200);
    const f = (
      facilities.body as { id: string; myUnitCodes: string[]; directionsUrl: string }[]
    )[0]!;
    expect(f.id).toBe(fac.facilityId);
    expect(f.myUnitCodes.length).toBe(1);
    expect(f.directionsUrl).toContain('google.com/maps');
  });

  it('facturas del año en un ZIP, borrar un documento propio y preferencias', async () => {
    const owner = await registerVerifiedUser(app, 'pim-zip');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Zip' });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const year = new Date().getFullYear();
    const zip = await http().get(`/portal/me/invoices/annual?year=${year}`).set(portal).expect(200);
    expect(zip.body.invoices).toBe(1);
    expect(zip.body.url).toContain('http');
    const none = await http().get('/portal/me/invoices/annual?year=2001').set(portal);
    expect(none.status).toBe(404);

    // Documentos: el suyo se borra; el que añadió el equipo, no.
    const tenantId = (await admin.customer.findUniqueOrThrow({ where: { id: customerId } }))
      .tenantId;
    const base = {
      tenantId,
      customerId,
      type: 'other' as const,
      fileUrl: 'http://localhost:9000/storageos-uploads/x.pdf',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      fileSize: 10,
    };
    const mine = await admin.customerDocument.create({ data: base });
    const staffUser = await admin.user.findFirstOrThrow({ where: { tenantId } });
    const theirs = await admin.customerDocument.create({
      data: { ...base, uploadedByUserId: staffUser.id },
    });
    await http().delete(`/portal/me/documents/${mine.id}`).set(portal).expect(204);
    const denied = await http().delete(`/portal/me/documents/${theirs.id}`).set(portal);
    expect(denied.status).toBe(400);
    expect(await admin.customerDocument.count({ where: { customerId } })).toBe(1);

    // Preferencias: baja de lo comercial y del WhatsApp.
    const prefs = await http().get('/portal/me/preferences').set(portal).expect(200);
    expect(prefs.body).toEqual({ marketing: true, whatsapp: true });
    const off = await http()
      .patch('/portal/me/preferences')
      .set(portal)
      .send({ marketing: false, whatsapp: false })
      .expect(200);
    expect(off.body).toEqual({ marketing: false, whatsapp: false });
    const c = await admin.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(c.marketingOptOutAt).not.toBeNull();
    expect(c.whatsappOptOutAt).not.toBeNull();
  });

  it('cambia su email con el enlace de confirmación', async () => {
    const owner = await registerVerifiedUser(app, 'pim-email');
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Mail',
      email: `old-${Date.now()}@e2e.local`,
    });
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const newEmail = `new-${Date.now()}@e2e.local`;
    await http().post('/portal/me/email-change').set(portal).send({ email: newEmail }).expect(204);

    // El enlace va en el correo; en la prueba se lee de Redis y se rehace.
    const queue = app.get<{ client: Promise<unknown> }>(getQueueToken('email'), { strict: false });
    const redis = (await queue.client) as {
      keys: (p: string) => Promise<string[]>;
      get: (k: string) => Promise<string | null>;
      set: (k: string, v: string, ...a: unknown[]) => Promise<unknown>;
    };
    let key: string | null = null;
    for (const k of await redis.keys('portal:emailchange:*')) {
      const v = JSON.parse((await redis.get(k)) ?? '{}') as { customerId?: string };
      if (v.customerId === customerId) key = k;
    }
    expect(key).toBeTruthy();
    const { hash } = await import('@node-rs/argon2');
    const entry = JSON.parse((await redis.get(key!))!) as Record<string, unknown>;
    await redis.set(key!, JSON.stringify({ ...entry, secretHash: await hash('s3cret-e2e') }));
    const tokenId = key!.replace('portal:emailchange:', '');

    const res = await http()
      .post('/portal/email-change/confirm')
      .send({ token: `${tokenId}.s3cret-e2e` })
      .expect(200);
    expect(res.body.email).toBe(newEmail);
    const c = await admin.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(c.email).toBe(newEmail);
    // Un solo uso.
    await http()
      .post('/portal/email-change/confirm')
      .send({ token: `${tokenId}.s3cret-e2e` })
      .expect(401);
  });

  it('cambia la fecha de una baja ya pedida respetando el preaviso', async () => {
    const owner = await registerVerifiedUser(app, 'pim-moveout');
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Baja' });
    const id = await signed(owner.accessToken, customerId, fac.unitIds[0]!);
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    // Sin baja pedida no se puede cambiar la fecha.
    const early = await http()
      .post(`/portal/me/contracts/${id}/move-out-date`)
      .set(portal)
      .send({ endDate: day(40) });
    expect(early.status).toBe(400);
    await http()
      .post(`/portal/me/contracts/${id}/request-move-out`)
      .set(portal)
      .send({ endDate: day(30) })
      .expect(200);
    const tooSoon = await http()
      .post(`/portal/me/contracts/${id}/move-out-date`)
      .set(portal)
      .send({ endDate: day(2) });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.code).toBe('notice_period_not_met');
    const moved = await http()
      .post(`/portal/me/contracts/${id}/move-out-date`)
      .set(portal)
      .send({ endDate: day(45) })
      .expect(200);
    expect(moved.body.endDate).toBe(day(45));
    expect(moved.body.status).toBe('ending');
  });

  it('pagar varias facturas en una sola orden de Redsys', async () => {
    const owner = await registerVerifiedUser(app, 'pim-payall');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    await http()
      .put('/settings/redsys')
      .set(auth)
      .send({
        merchantCode: '999008881',
        terminal: '1',
        secretKey: TEST_KEY,
        environment: 'test',
        enabled: true,
      })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken, { firstName: 'Todo' });
    const a = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 100 });
    const b = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await http().post(`/invoices/${a}/issue`).set(auth).expect(200);
    await http().post(`/invoices/${b}/issue`).set(auth).expect(200);
    const portal = {
      Authorization: `Bearer ${await portalSession(owner.accessToken, customerId)}`,
    };
    const redirect = await http()
      .post(`/portal/me/invoices/${a}/redsys-redirect`)
      .set(portal)
      .send({ extraInvoiceIds: [b] })
      .expect(200);
    const params = JSON.parse(
      Buffer.from(redirect.body.merchantParameters, 'base64').toString('utf8'),
    ) as Record<string, string>;
    expect(params.DS_MERCHANT_AMOUNT).toBe('18150'); // (100 + 50) + 21 %

    const { encodeMerchantParameters, signRequest } =
      await import('../src/modules/payments/redsys/redsys-signature');
    const order = params.DS_MERCHANT_ORDER!;
    const notif = encodeMerchantParameters({
      Ds_Order: order,
      Ds_Response: '0000',
      Ds_Amount: '18150',
    });
    await http()
      .post('/webhooks/redsys')
      .send({
        Ds_SignatureVersion: 'HMAC_SHA256_V1',
        Ds_MerchantParameters: notif,
        Ds_Signature: signRequest(notif, order, TEST_KEY),
      })
      .expect(200);
    const rows = await admin.invoice.findMany({ where: { id: { in: [a, b] } } });
    expect(rows.every((r) => r.status === 'paid')).toBe(true);

    // Una factura de otro inquilino no se puede juntar.
    const otherCustomer = await createCustomer(app, owner.accessToken, { firstName: 'Otro' });
    const c = await createDraftInvoice(app, owner.accessToken, otherCustomer);
    await http().post(`/invoices/${c}/issue`).set(auth).expect(200);
    const d = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${d}/issue`).set(auth).expect(200);
    const mixed = await http()
      .post(`/portal/me/invoices/${d}/redsys-redirect`)
      .set(portal)
      .send({ extraInvoiceIds: [c] });
    expect(mixed.status).toBe(404);
  });
});
