import { earliestRentIncreaseDate } from '@storageos/shared';
import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { RentIncreasesService } from '../src/modules/rent-increases/rent-increases.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayYmd = () => ymd(todayInTimezone('Europe/Madrid'));

describe('Cartera: mejoras de subidas y renovaciones (e2e)', () => {
  let app: INestApplication;
  let db: PrismaAdminService;
  const http = () => request(app.getHttpServer());
  const first = earliestRentIncreaseDate(todayYmd(), 30);

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    db = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function setup(tag: string, units: number, price = 60) {
    const owner = await registerVerifiedUser(app, tag);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: units,
      pricePerUnit: price,
    });
    await http()
      .patch('/rent-increases/policy')
      .set(auth)
      .send({ minMonthsBetween: 0, maxAnnualPct: 0 })
      .expect(200);
    return { owner, auth, fac };
  }

  async function signed(
    auth: { Authorization: string },
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
    customer: Parameters<typeof createCustomer>[2] = {},
  ) {
    const customerId = await createCustomer(app, token, customer);
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

  async function portalSession(auth: { Authorization: string }, customerId: string) {
    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  const tokenOf = (url: string) => new URL(url).pathname.split('/').pop()!;

  it('hasta la tarifa, quitando contratos a mano y con «no subir hasta»', async () => {
    const { owner, auth, fac } = await setup('pf-list', 4, 60);
    const normal = await signed(auth, owner.accessToken, fac.unitIds[0]!);
    const removed = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    const exempt = await signed(auth, owner.accessToken, fac.unitIds[2]!);
    await signed(auth, owner.accessToken, fac.unitIds[3]!, { priceMonthly: 70 });

    const later = ymd(new Date(new Date(`${first}T00:00:00Z`).getTime() + 40 * DAY));
    await http()
      .put(`/contracts/${exempt.id}/rent-increase-exemption`)
      .set(auth)
      .send({ until: later, reason: 'Acuerdo comercial' })
      .expect(204);
    const past = await http()
      .put(`/contracts/${exempt.id}/rent-increase-exemption`)
      .set(auth)
      .send({ until: '2020-01-01' });
    expect(past.status).toBe(400);
    const detail = await http().get(`/contracts/${exempt.id}`).set(auth).expect(200);
    expect(detail.body.rentIncreaseExemptUntil).toBe(later);

    const base = {
      increaseType: 'to_list_price',
      increaseValue: 50,
      scope: { minMonthsSinceSigned: 0 },
      effectiveDate: first,
    };
    const preview = await http().post('/rent-increases/preview').set(auth).send(base).expect(200);
    expect(preview.body.affectedCount).toBe(2);
    expect((preview.body.contracts as { newPrice: number }[]).every((c) => c.newPrice === 60)).toBe(
      true,
    );
    const reasons = Object.fromEntries(
      (preview.body.excluded as { reason: string; count: number }[]).map((e) => [
        e.reason,
        e.count,
      ]),
    );
    expect(reasons).toMatchObject({ exempt: 1, at_list_price: 1 });

    const created = await http()
      .post('/rent-increases')
      .set(auth)
      .send({ ...base, name: 'A tarifa', excludeContractIds: [removed.id] })
      .expect(201);
    expect(created.body.affectedCount).toBe(1);
    expect(created.body.mrrDelta).toBe(10);
    expect((created.body.items as { contractId: string }[])[0]!.contractId).toBe(normal.id);
  });

  it('aviso con texto propio, vista previa, constancia, reenviar y quitar', async () => {
    const { owner, auth, fac } = await setup('pf-notice', 2, 50);
    const a = await signed(auth, owner.accessToken, fac.unitIds[0]!, {}, { firstName: 'Lucía' });
    const b = await signed(auth, owner.accessToken, fac.unitIds[1]!);

    const tpl = await http().get('/rent-increases/notice-template').set(auth).expect(200);
    expect(tpl.body.template).toBeNull();
    expect(tpl.body.defaults.es.subject).toContain('{trastero}');
    await http()
      .put('/rent-increases/notice-template')
      .set(auth)
      .send({
        template: {
          es: {
            subject: 'Tu cuota cambia, {nombre}',
            body: 'Hola {nombre}, desde el {fecha} pagarás {cuota_nueva} por el {trastero}.',
          },
        },
      })
      .expect(200);
    const preview = await http()
      .post('/rent-increases/notice-preview')
      .set(auth)
      .send({ contractId: a.id, newPrice: 55, locale: 'es', effectiveDate: first })
      .expect(200);
    expect(preview.body.subject).toBe('Tu cuota cambia, Lucía');
    expect(preview.body.text).toMatch(/66,55\s€/);
    // La baja sin preaviso va siempre, aunque el texto sea propio.
    expect(preview.body.text).toContain('sin preaviso ni penalización');

    const created = await http()
      .post('/rent-increases')
      .set(auth)
      .send({
        name: 'Con texto propio',
        increaseType: 'percentage',
        increaseValue: 10,
        scope: { minMonthsSinceSigned: 0 },
        effectiveDate: first,
      })
      .expect(201);
    const id = created.body.id as string;
    const comms = await http()
      .get(`/communications?source=customer_email.rent_increase_notice&contractId=${a.id}`)
      .set(auth)
      .expect(200);
    expect((comms.body as { subject: string }[])[0]!.subject).toBe('Tu cuota cambia, Lucía');
    const items = created.body.items as {
      id: string;
      contractId: string;
      noticeDelivery: string | null;
    }[];
    const itemA = items.find((i) => i.contractId === a.id)!;
    const itemB = items.find((i) => i.contractId === b.id)!;
    expect(['pending', 'sent', 'delivered']).toContain(itemA.noticeDelivery);

    // Rebota el correo: se ve en la ficha y se puede reenviar. Antes se espera a
    // que la cola lo envíe (si no, el envío lo vuelve a dejar como «enviado»).
    for (let i = 0; i < 50; i++) {
      const pending = await db.communication.count({
        where: {
          contractId: a.id,
          source: 'customer_email.rent_increase_notice',
          status: { in: ['pending', 'processing'] },
        },
      });
      if (pending === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await db.communication.updateMany({
      where: { contractId: a.id, source: 'customer_email.rent_increase_notice' },
      data: { status: 'bounced' },
    });
    const bounced = await http().get(`/rent-increases/${id}`).set(auth).expect(200);
    expect(
      (bounced.body.items as { id: string; noticeDelivery: string }[]).find(
        (i) => i.id === itemA.id,
      )!.noticeDelivery,
    ).toBe('bounced');
    const resent = await http()
      .post(`/rent-increases/${id}/items/${itemA.id}/resend`)
      .set(auth)
      .expect(200);
    expect(
      (resent.body.items as { id: string; noticeDelivery: string }[]).find(
        (i) => i.id === itemA.id,
      )!.noticeDelivery,
    ).not.toBe('bounced');

    // Quitar a uno: no le sube y le llega la anulación.
    const afterRemove = await http()
      .post(`/rent-increases/${id}/items/${itemB.id}/remove`)
      .set(auth)
      .expect(200);
    const removedItem = (
      afterRemove.body.items as { id: string; status: string; skipReason: string }[]
    ).find((i) => i.id === itemB.id)!;
    expect(removedItem).toMatchObject({ status: 'skipped', skipReason: 'removed' });
    const cancelled = await http()
      .get(`/communications?source=customer_email.rent_increase_cancelled&contractId=${b.id}`)
      .set(auth)
      .expect(200);
    expect(cancelled.body).toHaveLength(1);
    const again = await http().post(`/rent-increases/${id}/items/${itemB.id}/remove`).set(auth);
    expect(again.status).toBe(400);

    // Quitando al último pendiente, la subida queda cancelada.
    await http().post(`/rent-increases/${id}/items/${itemA.id}/remove`).set(auth).expect(200);
    const final = await http().get(`/rent-increases/${id}`).set(auth).expect(200);
    expect(final.body.status).toBe('cancelled');

    // Volver al texto de serie.
    await http()
      .put('/rent-increases/notice-template')
      .set(auth)
      .send({ template: null })
      .expect(200);
    expect(
      (await http().get('/rent-increases/notice-template').set(auth)).body.template,
    ).toBeNull();
  });

  it('resultados de una subida: lo que se cobra de más y quién se fue tras el aviso', async () => {
    const { owner, auth, fac } = await setup('pf-results', 2, 50);
    await signed(auth, owner.accessToken, fac.unitIds[0]!);
    const leaving = await signed(auth, owner.accessToken, fac.unitIds[1]!);
    const created = await http()
      .post('/rent-increases')
      .set(auth)
      .send({
        name: 'Resultados',
        increaseType: 'fixed',
        increaseValue: 5,
        scope: { minMonthsSinceSigned: 0 },
        effectiveDate: first,
      })
      .expect(201);
    const id = created.body.id as string;
    await http()
      .post(`/contracts/${leaving.id}/request-end`)
      .set(auth)
      .send({ endDate: ymd(new Date(new Date(`${first}T00:00:00Z`).getTime() - DAY)) })
      .expect(200);
    await app.get(RentIncreasesService).applyDue(new Date(`${first}T12:00:00Z`));
    const res = await http().get(`/rent-increases/${id}/results`).set(auth).expect(200);
    expect(res.body).toMatchObject({ applied: 1, plannedMonthly: 10, realMonthly: 5 });
    expect(res.body.lostMonthly).toBe(50);
    expect((res.body.left as { contractId: string }[]).map((l) => l.contractId)).toEqual([
      leaving.id,
    ]);
  });

  it('bandeja de renovaciones, oferta firmada como anexo, cuotas previstas e historial', async () => {
    const { owner, auth, fac } = await setup('pf-renew', 2, 50);
    const t = todayInTimezone('Europe/Madrid');
    const soon = ymd(new Date(t.getTime() + 20 * DAY));
    const overdue = ymd(new Date(t.getTime() - 5 * DAY));
    const c = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      endDate: soon,
      autoRenew: false,
    });
    await signed(auth, owner.accessToken, fac.unitIds[1]!, {
      endDate: ymd(new Date(t.getTime() + 75 * DAY)),
      autoRenew: false,
    });

    const in30 = await http().get('/portfolio/renewals?window=30').set(auth).expect(200);
    expect((in30.body as { contractId: string }[]).map((r) => r.contractId)).toEqual([c.id]);
    expect(in30.body[0]).toMatchObject({
      endDate: soon,
      debt: 0,
      pendingOffer: null,
      status: 'active',
    });
    expect(in30.body[0].monthsAsCustomer).toBeGreaterThanOrEqual(1);
    const in90 = await http().get('/portfolio/renewals?window=90').set(auth).expect(200);
    expect(in90.body).toHaveLength(2);
    expect((await http().get('/portfolio/renewals?window=7').set(auth)).status).toBe(400);

    // Vencido y abierto: sale en «Vencidos».
    await db.contract.update({
      where: { id: c.id },
      data: { endDate: new Date(`${overdue}T00:00:00Z`) },
    });
    const late = await http().get('/portfolio/renewals?window=overdue').set(auth).expect(200);
    expect((late.body as { contractId: string }[]).map((r) => r.contractId)).toEqual([c.id]);
    await db.contract.update({
      where: { id: c.id },
      data: { endDate: new Date(`${soon}T00:00:00Z`) },
    });

    // Oferta de renovación: se firma como anexo y renueva sola.
    const offer = await http()
      .post(`/contracts/${c.id}/renewal-offer`)
      .set(auth)
      .send({ months: 6, newPrice: 55, note: 'Gracias por seguir con nosotros.' })
      .expect(201);
    expect(offer.body.annex.renewal).toEqual({ months: 6, newPrice: 55 });
    expect(offer.body.annex.termsText).toContain('6 meses más');
    const twice = await http()
      .post(`/contracts/${c.id}/renewal-offer`)
      .set(auth)
      .send({ months: 6 });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('renewal_offer_pending');
    const inbox = await http().get('/portfolio/renewals?window=30').set(auth).expect(200);
    expect(inbox.body[0].pendingOffer).toMatchObject({ months: 6, newPrice: 55 });

    const portal = await portalSession(auth, c.customerId);
    const mine = await http().get('/portal/me/annexes').set(portal).expect(200);
    expect((mine.body as { renewal: unknown }[])[0]!.renewal).toEqual({
      months: 6,
      newPrice: 55,
    });

    const token = tokenOf(offer.body.signingUrl as string);
    const view = await http().get(`/public/annexes/sign/${token}`).expect(200);
    await http()
      .post(`/public/annexes/sign/${token}`)
      .send({
        signerName: 'Cliente Apellido',
        method: 'typed',
        typedSignature: 'Cliente Apellido',
        accept: true,
        documentHash: view.body.documentHash,
      })
      .expect(201);
    const renewed = await http().get(`/contracts/${c.id}`).set(auth).expect(200);
    const expectedEnd = new Date(`${soon}T00:00:00Z`);
    expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 6);
    expect(renewed.body.endDate.slice(0, 10)).toBe(ymd(expectedEnd));
    expect(renewed.body.scheduledPrice).toMatchObject({ amount: 55 });
    const annexes = await http().get(`/contracts/${c.id}/annexes`).set(auth).expect(200);
    expect(annexes.body[0].actionAppliedAt).not.toBeNull();
    expect(annexes.body[0].actionError).toBeNull();

    // Cuotas previstas e historial: la cuota nueva aparece como prevista.
    const changes = await http().get('/portfolio/price-changes').set(auth).expect(200);
    expect(changes.body).toEqual([
      expect.objectContaining({
        contractId: c.id,
        currentPrice: 50,
        newPrice: 55,
        source: 'scheduled',
      }),
    ]);
    const history = await http().get(`/contracts/${c.id}/price-history`).set(auth).expect(200);
    const entries = history.body.entries as { kind: string; from: number | null; to: number }[];
    expect(entries[0]).toMatchObject({ kind: 'start', to: 50 });
    expect(entries.at(-1)).toMatchObject({ kind: 'scheduled', from: 50, to: 55 });
  });

  it('oferta que ya no encaja: se firma, no se aplica y se avisa', async () => {
    const { owner, auth, fac } = await setup('pf-stale', 1, 50);
    const t = todayInTimezone('Europe/Madrid');
    const c = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      endDate: ymd(new Date(t.getTime() + 15 * DAY)),
      autoRenew: false,
    });
    const offer = await http()
      .post(`/contracts/${c.id}/renewal-offer`)
      .set(auth)
      .send({ months: 12 })
      .expect(201);
    // Entretanto alguien lo renueva a mano.
    await http().post(`/contracts/${c.id}/renew`).set(auth).send({ months: 3 }).expect(200);
    const token = tokenOf(offer.body.signingUrl as string);
    const view = await http().get(`/public/annexes/sign/${token}`).expect(200);
    await http()
      .post(`/public/annexes/sign/${token}`)
      .send({
        signerName: 'Cliente Apellido',
        method: 'typed',
        typedSignature: 'Cliente Apellido',
        accept: true,
        documentHash: view.body.documentHash,
      })
      .expect(201);
    const annexes = await http().get(`/contracts/${c.id}/annexes`).set(auth).expect(200);
    expect(annexes.body[0].actionAppliedAt).toBeNull();
    expect(annexes.body[0].actionError).toBeTruthy();
    const notes = await db.notification.findMany({
      where: { link: { contains: c.id }, title: { startsWith: 'Renovación aceptada sin aplicar' } },
    });
    expect(notes).toHaveLength(1);
  });

  it('actualización anual con % propio del contrato y «no subir hasta»', async () => {
    const { owner, auth, fac } = await setup('pf-anniv', 2, 100);
    await http()
      .put('/contract-anniversaries/settings')
      .set(auth)
      .send({ enabled: true, pct: 3, scope: 'all' })
      .expect(200);
    const t = todayInTimezone('Europe/Madrid');
    const inTen = new Date(t.getTime() + 10 * DAY);
    const start = ymd(
      new Date(Date.UTC(inTen.getUTCFullYear() - 1, inTen.getUTCMonth(), inTen.getUTCDate())),
    );
    const own = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      startDate: start,
      priceMonthly: 100,
    });
    const exempt = await signed(auth, owner.accessToken, fac.unitIds[1]!, {
      startDate: start,
      priceMonthly: 100,
    });
    await http().put(`/contracts/${own.id}/anniversary-pct`).set(auth).send({ pct: 5 }).expect(204);
    expect(
      (await http().put(`/contracts/${own.id}/anniversary-pct`).set(auth).send({ pct: 90 })).status,
    ).toBe(400);
    await http()
      .put(`/contracts/${exempt.id}/rent-increase-exemption`)
      .set(auth)
      .send({ until: ymd(new Date(t.getTime() + 60 * DAY)) })
      .expect(204);
    const due = await http().get('/contract-anniversaries/due').set(auth).expect(200);
    const rows = due.body as {
      contractId: string;
      pct: number;
      customPct: boolean;
      newPrice: number;
    }[];
    expect(rows.find((r) => r.contractId === exempt.id)).toBeUndefined();
    expect(rows.find((r) => r.contractId === own.id)).toMatchObject({
      pct: 5,
      customPct: true,
      newPrice: 105,
    });
    // En «Cuotas previstas» sale como actualización anual por revisar.
    const changes = await http().get('/portfolio/price-changes').set(auth).expect(200);
    expect(changes.body).toEqual([
      expect.objectContaining({ contractId: own.id, source: 'anniversary', newPrice: 105 }),
    ]);
    // Quitar el % propio vuelve al del negocio.
    await http()
      .put(`/contracts/${own.id}/anniversary-pct`)
      .set(auth)
      .send({ pct: null })
      .expect(204);
    const due2 = await http().get('/contract-anniversaries/due').set(auth).expect(200);
    expect(
      (due2.body as { contractId: string; pct: number }[]).find((r) => r.contractId === own.id)!
        .pct,
    ).toBe(3);
  });

  it('aviso de prórroga automática 30 días antes', async () => {
    const { owner, auth, fac } = await setup('pf-autorenew', 1, 50);
    const t = todayInTimezone('Europe/Madrid');
    const c = await signed(auth, owner.accessToken, fac.unitIds[0]!, {
      startDate: ymd(new Date(t.getTime() - 340 * DAY)),
      endDate: ymd(new Date(t.getTime() + 20 * DAY)),
      autoRenew: true,
    });
    const { ContractEndingSoonCron } =
      await import('../src/modules/contracts/contract-ending-soon.cron');
    await app.get(ContractEndingSoonCron).run();
    let comms: { subject: string }[] = [];
    for (let i = 0; i < 20 && comms.length === 0; i++) {
      comms = (
        await http()
          .get(
            `/communications?source=customer_email.contract_auto_renewal_notice&contractId=${c.id}`,
          )
          .set(auth)
      ).body as { subject: string }[];
      if (comms.length === 0) await new Promise((r) => setTimeout(r, 150));
    }
    expect(comms).toHaveLength(1);
    expect(comms[0]!.subject).toContain('se prorroga');
  });
});
