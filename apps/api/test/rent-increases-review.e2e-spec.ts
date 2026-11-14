import { earliestRentIncreaseDate } from '@storageos/shared';
import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';
import { ContractsService } from '../src/modules/contracts/contracts.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { RentIncreasesService } from '../src/modules/rent-increases/rent-increases.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayYmd = () => ymd(todayInTimezone('Europe/Madrid'));
const addMonthsYmd = (s: string, months: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months, 1);
  return ymd(d);
};

describe('Subidas de precio y renovaciones: revisión (e2e)', () => {
  let app: INestApplication;
  let db: PrismaAdminService;
  const http = () => request(app.getHttpServer());
  // Primer día 1 con 30 días de preaviso y el siguiente.
  const first = earliestRentIncreaseDate(todayYmd(), 30);
  const second = addMonthsYmd(first, 1);

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    db = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(tag: string, units: number, price = 50) {
    const owner = await registerVerifiedUser(app, tag);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: units,
      pricePerUnit: price,
    });
    const me = await http().get('/auth/me').set(auth);
    await http()
      .patch('/rent-increases/policy')
      .set(auth)
      .send({ minMonthsBetween: 0, maxAnnualPct: 0 })
      .expect(200);
    return { owner, auth, fac, tenantId: me.body.tenant.id as string };
  }

  async function signed(
    auth: { Authorization: string },
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
  ) {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 50,
        depositAmount: 0,
        ...body,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { id: c.body.id as string, customerId };
  }

  const batch = (auth: { Authorization: string }, value: number, date: string, extra = {}) =>
    http()
      .post('/rent-increases')
      .set(auth)
      .send({
        name: `Subida ${value}`,
        increaseType: 'percentage',
        increaseValue: value,
        scope: { minMonthsSinceSigned: 0 },
        effectiveDate: date,
        ...extra,
      });

  const priceOf = async (auth: { Authorization: string }, id: string) =>
    (await http().get(`/contracts/${id}`).set(auth)).body.priceMonthly as number;

  it('fechas: día 1, real y con el preaviso; subida con tope', async () => {
    const { owner, auth, fac } = await setup('rir-dates', 1);
    await signed(auth, owner.accessToken, fac.unitIds[0]!);
    const notFirst = await batch(auth, 5, `${first.slice(0, 8)}15`);
    expect(notFirst.status).toBe(400);
    const month13 = await batch(auth, 5, '2026-13-01');
    expect(month13.status).toBe(400);
    const feb31 = await batch(auth, 5, '2027-02-31');
    expect(feb31.status).toBe(400);
    const past = await batch(auth, 5, '2020-01-01');
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('notice_too_short');
    expect(past.body.details.minDate).toBe(first);
    const huge = await batch(auth, 900, first);
    expect(huge.status).toBe(400);
    // Con más preaviso, la primera fecha posible se mueve.
    await http().patch('/rent-increases/policy').set(auth).send({ noticeDays: 60 }).expect(200);
    const tooSoon = await batch(auth, 5, first);
    const minDate = earliestRentIncreaseDate(todayYmd(), 60);
    if (minDate > first) {
      expect(tooSoon.status).toBe(400);
      expect(tooSoon.body.details.minDate).toBe(minDate);
    }
  });

  it('quién entra: fuera bajas, viviendas, ya programados y lo que pasa del tope en 12 meses', async () => {
    const { owner, auth, fac } = await setup('rir-scope', 5);
    const housing = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    await db.unitType.update({
      where: { id: housing.unitTypeId },
      data: { propertyKind: 'housing' },
    });
    const ok = await signed(auth, owner.accessToken, fac.unitIds[0]!);
    const ending = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    await http().post(`/contracts/${ending.id}/request-end`).set(auth).send({}).expect(200);
    const scheduled = await signed(auth, owner.accessToken, fac.unitIds[2]!);
    await http()
      .post(`/contracts/${scheduled.id}/change-price`)
      .set(auth)
      .send({ priceMonthly: 60, reason: 'Acordado', effectiveDate: second })
      .expect(200);
    const leaving = await signed(auth, owner.accessToken, fac.unitIds[3]!, {
      endDate: ymd(new Date(Date.now() + 10 * 86_400_000)),
      autoRenew: false,
    });
    const raised = await signed(auth, owner.accessToken, fac.unitIds[4]!);
    // Subida a mano reciente: 50 → 54 (8 %).
    await http()
      .post(`/contracts/${raised.id}/change-price`)
      .set(auth)
      .send({ priceMonthly: 54, reason: 'Revisión' })
      .expect(200);
    await signed(auth, owner.accessToken, housing.unitIds[0]!);

    await http().patch('/rent-increases/policy').set(auth).send({ maxAnnualPct: 10 }).expect(200);
    const prev = await http()
      .post('/rent-increases/preview')
      .set(auth)
      .send({
        increaseType: 'percentage',
        increaseValue: 10,
        effectiveDate: first,
        scope: { minMonthsSinceSigned: 0 },
      })
      .expect(200);
    const ids = (prev.body.contracts as { contractId: string }[]).map((c) => c.contractId);
    expect(ids).toContain(ok.id);
    expect(ids).toContain(raised.id);
    expect(ids).not.toContain(ending.id);
    expect(ids).not.toContain(scheduled.id);
    expect(ids).not.toContain(leaving.id);
    const reasons = Object.fromEntries(
      (prev.body.excluded as { reason: string; count: number }[]).map((e) => [e.reason, e.count]),
    );
    expect(reasons).toMatchObject({
      ending: 1,
      housing: 1,
      already_scheduled: 1,
      leaving_before: 1,
    });
    // El tope del 10 % cuenta desde la cuota de hace 12 meses (50): 54 → 55, no 59,40.
    const r = (
      prev.body.contracts as { contractId: string; newPrice: number; raisedThisYear: boolean }[]
    ).find((c) => c.contractId === raised.id)!;
    expect(r.newPrice).toBe(55);
    expect(r.raisedThisYear).toBe(true);
    expect(prev.body.raisedThisYear).toBe(1);

    // Una segunda subida no puede coger los contratos de la primera.
    await batch(auth, 5, first).expect(201);
    const again = await batch(auth, 5, second);
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('no_contracts_affected');
  });

  it('aviso con IVA, en su idioma, en su ficha y anulación avisada', async () => {
    const { owner, auth, fac, tenantId } = await setup('rir-notice', 2);
    const es = await signed(auth, owner.accessToken, fac.unitIds[0]!, { discountAmount: 10 });
    const en = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    await db.customer.update({ where: { id: en.customerId }, data: { locale: 'en' } });
    const b = await batch(auth, 10, first).expect(201);
    const items = b.body.items as { contractId: string; noticeStatus: string }[];
    expect(items.every((i) => i.noticeStatus === 'sent')).toBe(true);
    const notices = await db.communication.findMany({
      where: { tenantId, source: 'customer_email.rent_increase_notice' },
      select: { customerId: true, contractId: true, bodyText: true },
    });
    expect(notices).toHaveLength(2);
    const esText = notices.find((n) => n.customerId === es.customerId)!.bodyText!;
    // (50 − 10) × 1,21 = 48,40 € → (55 − 10) × 1,21 = 54,45 €.
    expect(esText).toContain('48,40');
    expect(esText).toContain('54,45');
    expect(esText).toContain('sin preaviso ni penalización');
    expect(notices.find((n) => n.customerId === en.customerId)!.bodyText).toContain(
      'without notice or penalty',
    );
    expect(notices.every((n) => n.contractId)).toBe(true);

    await http().post(`/rent-increases/${b.body.id}/cancel`).set(auth).expect(200);
    const cancelled = await db.communication.count({
      where: { tenantId, source: 'customer_email.rent_increase_cancelled' },
    });
    expect(cancelled).toBe(2);
    const detail = await http().get(`/rent-increases/${b.body.id}`).set(auth).expect(200);
    expect(detail.body.status).toBe('cancelled');
    expect(
      (detail.body.items as { skipReason: string }[]).every((i) => i.skipReason === 'cancelled'),
    ).toBe(true);
    const audit = await db.auditLog.count({
      where: { tenantId, action: { in: ['rent_increase.created', 'rent_increase.cancelled'] } },
    });
    expect(audit).toBe(2);
  });

  it('al llegar la fecha: no baja la cuota cambiada a mano y no sube dos veces', async () => {
    const { owner, auth, fac } = await setup('rir-apply', 2);
    const k1 = await signed(auth, owner.accessToken, fac.unitIds[0]!);
    const k2 = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    const b = await batch(auth, 10, first).expect(201);
    // Entre el aviso y la fecha, la cuota de k2 se cambia a mano a 70.
    await http()
      .post(`/contracts/${k2.id}/change-price`)
      .set(auth)
      .send({ priceMonthly: 70, reason: 'Acuerdo' })
      .expect(200);
    const service = app.get(RentIncreasesService);
    const day = new Date(`${first}T12:00:00Z`);
    await Promise.all([service.applyDue(day), service.applyDue(day)]);
    expect(await priceOf(auth, k1.id)).toBe(55);
    expect(await priceOf(auth, k2.id)).toBe(70);
    const events = await db.contractEvent.count({
      where: {
        contractId: k1.id,
        eventType: 'price_changed',
        payload: { path: ['reason'], equals: `rent_increase:${b.body.id}` },
      },
    });
    expect(events).toBe(1);
    const detail = await http().get(`/rent-increases/${b.body.id}`).set(auth).expect(200);
    expect(detail.body.status).toBe('applied');
    expect(detail.body.appliedCount).toBe(1);
    const skipped = (detail.body.items as { contractId: string; skipReason: string }[]).find(
      (i) => i.contractId === k2.id,
    );
    expect(skipped?.skipReason).toBe('price_changed');
  });

  it('la factura del mes sale con la cuota nueva aunque el proceso diario no haya corrido', async () => {
    const { owner, auth, fac, tenantId } = await setup('rir-billing', 2, 100);
    await ensureDefaultSeries(app, owner.accessToken);
    const k1 = await signed(auth, owner.accessToken, fac.unitIds[0]!, { priceMonthly: 100 });
    const k2 = await signed(auth, owner.accessToken, fac.unitIds[1]!, { priceMonthly: 100 });
    await batch(auth, 10, first).expect(201);
    await http()
      .post(`/contracts/${k2.id}/change-price`)
      .set(auth)
      .send({ priceMonthly: 130, reason: 'Programada', effectiveDate: first })
      .expect(200);
    const end = new Date(`${first}T00:00:00Z`);
    end.setUTCMonth(end.getUTCMonth() + 1, 0);
    await app
      .get(BillingJobsService)
      .processGenerateRecurring({ tenantId, periodStart: first, periodEnd: ymd(end) });
    const rentOf = async (contractId: string) => {
      const inv = await db.invoice.findFirst({
        where: { contractId, periodStart: new Date(`${first}T00:00:00Z`) },
        include: { items: true },
      });
      return Number(inv?.items[0]?.unitPrice);
    };
    expect(await rentOf(k1.id)).toBe(110);
    // k2 tenía otra cuota programada para ese día: manda la programada.
    expect(await rentOf(k2.id)).toBe(130);
  });

  it('área de clientes: ve la cuota nueva y puede irse antes sin preaviso', async () => {
    const { owner, auth, fac } = await setup('rir-portal', 1);
    const k = await signed(auth, owner.accessToken, fac.unitIds[0]!);
    await batch(auth, 10, first).expect(201);
    const link = await http().post(`/customers/${k.customerId}/portal-link`).set(auth);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const session = await http().post('/portal/login/consume').send({ token }).expect(200);
    const pAuth = { Authorization: `Bearer ${session.body.accessToken}` };
    const list = await http().get('/portal/me/contracts').set(pAuth).expect(200);
    const mine = (list.body as { id: string; upcomingPrice: unknown }[]).find(
      (c) => c.id === k.id,
    )!;
    // 55 € × 1,21 = 66,55 €.
    expect(mine.upcomingPrice).toEqual({
      monthlyWithVat: 66.55,
      date: first,
      canLeaveWithoutNotice: true,
    });
    // Baja para mañana: sin los 15 días de preaviso, porque es antes de la subida
    // (con baja a final de mes, el último día del mes, siempre antes de la subida).
    const tomorrow = ymd(new Date(todayInTimezone('Europe/Madrid').getTime() + 86_400_000));
    const out = await http()
      .post(`/portal/me/contracts/${k.id}/request-move-out`)
      .set(pAuth)
      .send({ endDate: tomorrow });
    expect(out.status).toBe(200);
    expect(out.body.endDate >= tomorrow).toBe(true);
    expect(out.body.endDate < first).toBe(true);
    // Ya en baja: al llegar la fecha no se le sube.
    await app.get(RentIncreasesService).applyDue(new Date(`${first}T12:00:00Z`));
    expect(await priceOf(auth, k.id)).toBe(50);
  });

  it('renovar: sin dobles, sin fecha de fin no hay nada que renovar y nada a medias', async () => {
    const { owner, auth, fac } = await setup('rir-renew', 3);
    const end = ymd(new Date(Date.now() + 20 * 86_400_000));
    const k = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      endDate: end,
      discountAmount: 20,
    });
    const bad = await http()
      .post(`/contracts/${k.id}/renew`)
      .set(auth)
      .send({ months: 12, newPrice: 10, expectedEndDate: end });
    expect(bad.status).toBe(400);
    expect((await http().get(`/contracts/${k.id}`).set(auth)).body.endDate).toBe(end);

    const ok = await http()
      .post(`/contracts/${k.id}/renew`)
      .set(auth)
      .send({ months: 12, newPrice: 60, expectedEndDate: end })
      .expect(200);
    // Doble clic: la segunda ya no coincide con el fin que vio.
    const twice = await http()
      .post(`/contracts/${k.id}/renew`)
      .set(auth)
      .send({ months: 12, expectedEndDate: end });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('contract_changed');
    expect((await http().get(`/contracts/${k.id}`).set(auth)).body.endDate).toBe(ok.body.endDate);
    // Un solo correo, con la cuota nueva.
    await new Promise((r) => setTimeout(r, 300));
    const mails = await db.communication.findMany({
      where: { contractId: k.id, source: { startsWith: 'customer_email.contract_' } },
      select: { source: true, bodyText: true },
    });
    const kinds = mails.map((m) => m.source);
    expect(kinds).toContain('customer_email.contract_renewed');
    expect(kinds).not.toContain('customer_email.contract_price_change');
    // (60 − 20) × 1,21 = 48,40 €.
    expect(mails.find((m) => m.source === 'customer_email.contract_renewed')!.bodyText).toContain(
      '48,40',
    );

    const indefinite = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    const r = await http().post(`/contracts/${indefinite.id}/renew`).set(auth).send({ months: 12 });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('contract_indefinite');

    // La lista incluye los vencidos que siguen abiertos.
    const overdue = await signed(auth, owner.accessToken, fac.unitIds[2]!, { endDate: end });
    const y = todayInTimezone('Europe/Madrid');
    await db.contract.update({
      where: { id: overdue.id },
      data: { endDate: new Date(y.getTime() - 3 * 86_400_000) },
    });
    const list = await http().get('/contracts/renewals').set(auth).expect(200);
    expect((list.body as { id: string }[]).map((c) => c.id)).toContain(overdue.id);
    expect((await http().get('/contracts/renewals?facilityId=abc').set(auth)).status).toBe(400);
  });

  it('actualización anual: programada para su aniversario, con aviso y sin repetirse', async () => {
    const { owner, auth, fac, tenantId } = await setup('rir-anniv', 2, 100);
    await http()
      .put('/contract-anniversaries/settings')
      .set(auth)
      .send({ enabled: true, pct: 3, scope: 'all' })
      .expect(200);
    const t = todayInTimezone('Europe/Madrid');
    // Aniversario dentro de 10 días.
    const inTen = new Date(t.getTime() + 10 * 86_400_000);
    const start = ymd(
      new Date(Date.UTC(inTen.getUTCFullYear() - 1, inTen.getUTCMonth(), inTen.getUTCDate())),
    );
    const future = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      startDate: start,
      priceMonthly: 100,
    });
    // Aniversario hace 90 días: antes se perdía a los 60.
    const ago = new Date(t.getTime() - 90 * 86_400_000);
    const late = await signed(auth, owner.accessToken, fac.unitIds[1]!, {
      startDate: ymd(
        new Date(Date.UTC(ago.getUTCFullYear() - 1, ago.getUTCMonth(), ago.getUTCDate())),
      ),
      priceMonthly: 100,
    });
    const due = await http().get('/contract-anniversaries/due').set(auth).expect(200);
    const rows = due.body as { contractId: string; late: boolean }[];
    expect(rows.find((r) => r.contractId === late.id)?.late).toBe(true);
    expect(rows.some((r) => r.contractId === future.id)).toBe(true);

    const res = await http()
      .post('/contract-anniversaries/apply')
      .set(auth)
      .send({ contractIds: [future.id], action: 'apply' })
      .expect(200);
    expect(res.body).toMatchObject({ applied: 1, scheduled: 1 });
    const c = (await http().get(`/contracts/${future.id}`).set(auth)).body;
    expect(c.priceMonthly).toBe(100);
    expect(c.scheduledPrice).toMatchObject({ amount: 103, date: ymd(inTen) });
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.communication.count({
        where: { tenantId, contractId: future.id, source: 'customer_email.contract_price_change' },
      }),
    ).toBe(1);
    // Ya no se vuelve a proponer.
    const due2 = await http().get('/contract-anniversaries/due').set(auth).expect(200);
    expect((due2.body as { contractId: string }[]).some((r) => r.contractId === future.id)).toBe(
      false,
    );
    // Aplicar el cambio programado y comprobar que tampoco reaparece.
    await app
      .get(ContractsService)
      .applyScheduledChanges(new Date(inTen.getTime() + 6 * 3_600_000));
    const due3 = await http().get('/contract-anniversaries/due').set(auth).expect(200);
    expect((due3.body as { contractId: string }[]).some((r) => r.contractId === future.id)).toBe(
      false,
    );
  });

  it('ajustes de toda la empresa: solo quien ve todos los locales', async () => {
    const { owner, auth, fac } = await setup('rir-scopeset', 0);
    void auth;
    const scoped = await scopedUser(app, owner, { role: 'manager', facilityIds: [fac.facilityId] });
    const policy = await http()
      .patch('/rent-increases/policy')
      .set(scoped)
      .send({ maxAnnualPct: 50 });
    expect(policy.status).toBe(403);
    expect(policy.body.code).toBe('requires_all_facilities');
    const anniv = await http()
      .put('/contract-anniversaries/settings')
      .set(scoped)
      .send({ enabled: true, pct: 9, scope: 'all' });
    expect(anniv.status).toBe(403);
  });
});
