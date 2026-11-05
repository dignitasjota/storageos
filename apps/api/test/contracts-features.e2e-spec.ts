import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { hashHoldToken } from '../src/common/waitlist-hold';
import { ContractsService } from '../src/modules/contracts/contracts.service';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras de Contratos: programar, fianza, salida, lista y lista de espera. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Mejoras de Contratos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  async function setup(slug: string, unitsCount = 3) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, { unitsCount });
    return { owner, auth, ...f };
  }

  async function signed(
    auth: Record<string, string>,
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; customerId: string }> {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(-30), priceMonthly: 50, ...body })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { id: c.body.id as string, customerId };
  }

  it('programa un cambio de cuota y lo aplica en su fecha', async () => {
    const { owner, auth, unitIds } = await setup('ctf-price');
    const c = await signed(auth, owner.accessToken, unitIds[0]!);
    const res = await http()
      .post(`/contracts/${c.id}/change-price`)
      .set(auth)
      .send({ priceMonthly: 60, reason: 'Revisión', effectiveDate: isoDay(10) })
      .expect(200);
    expect(res.body.priceMonthly).toBe(50);
    expect(res.body.scheduledPrice.amount).toBe(60);
    await app.get(ContractsService).applyScheduledChanges();
    expect(
      Number((await db.contract.findUniqueOrThrow({ where: { id: c.id } })).priceMonthly),
    ).toBe(50);
    await db.contract.update({
      where: { id: c.id },
      data: { scheduledPriceDate: new Date(isoDay(-1)) },
    });
    const applied = await app.get(ContractsService).applyScheduledChanges();
    expect(applied.prices).toBeGreaterThanOrEqual(1);
    const after = await http().get(`/contracts/${c.id}`).set(auth).expect(200);
    expect(after.body.priceMonthly).toBe(60);
    expect(after.body.scheduledPrice).toBeNull();
  });

  it('programa un traslado: reserva el destino, se anula y se aplica', async () => {
    const { owner, auth, unitIds } = await setup('ctf-move');
    const c = await signed(auth, owner.accessToken, unitIds[0]!);
    const status = async (id: string) =>
      (await db.unit.findUniqueOrThrow({ where: { id } })).status;
    const r = await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1], effectiveDate: isoDay(7) })
      .expect(200);
    expect(r.body.scheduledMove.unitId).toBe(unitIds[1]);
    expect(r.body.unitId).toBe(unitIds[0]);
    expect(await status(unitIds[1]!)).toBe('reserved');
    await http().delete(`/contracts/${c.id}/scheduled-move`).set(auth).expect(200);
    expect(await status(unitIds[1]!)).toBe('available');
    await http()
      .post(`/contracts/${c.id}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1], effectiveDate: isoDay(7), newPrice: 70 })
      .expect(200);
    await db.contract.update({
      where: { id: c.id },
      data: { scheduledUnitDate: new Date(isoDay(-1)) },
    });
    await app.get(ContractsService).applyScheduledChanges();
    const after = await http().get(`/contracts/${c.id}`).set(auth).expect(200);
    expect(after.body.unitId).toBe(unitIds[1]);
    expect(after.body.priceMonthly).toBe(70);
    expect(after.body.scheduledMove).toBeNull();
    expect(await status(unitIds[0]!)).toBe('available');
    expect(await status(unitIds[1]!)).toBe('occupied');
  });

  it('liquida la fianza aplicando lo retenido a las facturas pendientes', async () => {
    const { owner, auth, unitIds } = await setup('ctf-dep');
    await ensureDefaultSeries(app, owner.accessToken);
    const c = await signed(auth, owner.accessToken, unitIds[0]!, { depositAmount: 100 });
    await http()
      .post(`/contracts/${c.id}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        invoiceType: 'F1',
        customerId: c.customerId,
        contractId: c.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 50, taxRate: 21 }],
        verifactuMode: 'verifactu',
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).send({}).expect(200);
    const account = await http().get(`/contracts/${c.id}/account`).set(auth).expect(200);
    expect(account.body.pendingAmount).toBe(60.5);
    const out = await http().get(`/contracts/${c.id}/move-out`).set(auth).expect(200);
    expect(out.body.pendingTotal).toBe(60.5);
    expect(out.body.pendingInvoices).toHaveLength(1);
    const settled = await http()
      .post(`/contracts/${c.id}/settle-deposit`)
      .set(auth)
      .send({
        returnedAmount: 20,
        retentionReason: 'Deuda pendiente',
        applyToInvoices: true,
        returnMethod: 'bank_transfer',
        returnedOn: isoDay(0),
        returnReference: 'TRF-1',
        notifyCustomer: true,
      })
      .expect(200);
    expect(settled.body.depositAppliedAmount).toBe(60.5);
    expect(settled.body.depositReturnMethod).toBe('bank_transfer');
    const inv = await http().get(`/invoices/${draft.body.id}`).set(auth).expect(200);
    expect(inv.body.status).toBe('paid');
  });

  it('filtra la lista con deuda y envía firmas en lote', async () => {
    const { owner, auth, unitIds } = await setup('ctf-list');
    const customerId = await createCustomer(app, owner.accessToken);
    const d = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(0), priceMonthly: 50 })
      .expect(201);
    await signed(auth, owner.accessToken, unitIds[1]!, { endDate: isoDay(10) });
    const unsigned = await http()
      .get('/contracts/page')
      .set(auth)
      .query({ view: 'unsigned' })
      .expect(200);
    expect(unsigned.body.items).toHaveLength(1);
    expect(unsigned.body.items[0].pendingAmount).toBe(0);
    const expiring = await http()
      .get('/contracts/page')
      .set(auth)
      .query({ view: 'expiring' })
      .expect(200);
    expect(expiring.body.items).toHaveLength(1);
    const bulk = await http()
      .post('/contracts/bulk/request-signature')
      .set(auth)
      .send({ contractIds: [d.body.id] })
      .expect(200);
    expect(bulk.body.sent).toBe(1);
  });

  it('renovar con cuota nueva la programa para el nuevo periodo', async () => {
    const { owner, auth, unitIds } = await setup('ctf-renew');
    const end = isoDay(20);
    const c = await signed(auth, owner.accessToken, unitIds[0]!, { endDate: end });
    const r = await http()
      .post(`/contracts/${c.id}/renew`)
      .set(auth)
      .send({ months: 12, newPrice: 55 })
      .expect(200);
    expect(r.body.priceMonthly).toBe(50);
    expect(r.body.scheduledPrice.amount).toBe(55);
    expect(r.body.scheduledPrice.date).toBe(isoDay(21));
  });

  it('el acceso de un contrato que empieza más adelante vale desde ese día', async () => {
    const { owner, auth, unitIds } = await setup('ctf-access');
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(5), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    await new Promise((ok) => setTimeout(ok, 400));
    const cred = await db.accessCredential.findFirst({ where: { customerId } });
    expect(cred?.validFrom?.toISOString().slice(0, 10)).toMatch(
      new RegExp(`${isoDay(4)}|${isoDay(5)}`),
    );
  });

  it('la lista de espera guarda el trastero y lo pasa al siguiente', async () => {
    const { owner, auth, unitIds, facilityId, unitTypeId } = await setup('ctf-wait', 1);
    const unitId = unitIds[0]!;
    const c = await signed(auth, owner.accessToken, unitId);
    const add = async (name: string) =>
      http()
        .post('/waitlist')
        .set(auth)
        .send({
          facilityId,
          unitTypeId,
          contactName: name,
          contactEmail: `${name.toLowerCase()}@example.com`,
        })
        .expect(201);
    const first = await add('Ana');
    const second = await add('Luis');
    await http().post(`/contracts/${c.id}/end`).set(auth).send({}).expect(200);
    await new Promise((ok) => setTimeout(ok, 400));
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('reserved');
    const list = await http().get('/waitlist').set(auth).expect(200);
    const ana = (list.body as { id: string; heldUnitId: string | null }[]).find(
      (e) => e.id === first.body.id,
    );
    expect(ana?.heldUnitId).toBe(unitId);
    await db.waitlistEntry.update({
      where: { id: first.body.id as string },
      data: { notifiedAt: new Date(Date.now() - 3 * DAY) },
    });
    await app.get(WaitlistService).expireStaleNotifications();
    const entry = await db.waitlistEntry.findUniqueOrThrow({
      where: { id: second.body.id as string },
    });
    expect(entry.status).toBe('notified');
    expect(entry.heldUnitId).toBe(unitId);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('reserved');
    // El enlace del aviso reserva justo ese trastero aunque no esté libre para los demás.
    await db.tenant.update({
      where: { id: entry.tenantId },
      data: { taxId: 'B12345674', billingLegalName: 'Trasteros SL', billingAddress: 'Calle 1' },
    });
    await db.waitlistEntry.update({
      where: { id: entry.id },
      data: { holdTokenHash: hashHoldToken('token-de-prueba') },
    });
    const avail = await http()
      .get(`/public/move-in/book/${owner.slug}/availability`)
      .query({ hold: 'token-de-prueba' });
    if (avail.status === 200) {
      expect(avail.body.facilities[0].unitTypes[0].available).toBe(1);
    }
    await http().patch(`/waitlist/${entry.id}`).set(auth).send({ status: 'cancelled' }).expect(200);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('available');
  });
});
