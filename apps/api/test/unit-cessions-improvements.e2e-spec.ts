import { PrismaClient } from '@storageos/database';
import { isStaffPushType } from '@storageos/shared';
import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { UnitCessionsService } from '../src/modules/unit-cessions/unit-cessions.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { UnitCessionDto } from '@storageos/shared';

/**
 * Mejoras de los trasteros cedidos: avisos al propietario (campana, móvil y
 * correo, nunca a la persona), página «Cesiones», última entrada, ampliar en un
 * clic, pasar a contrato, sin fecha de fin, plazo de aviso y posponer, acceso
 * 24 h y varios códigos, y descuadres en la revisión de inventario.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const dayFromToday = (offset: number) => {
  const [y, m, d] = madridToday().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
};
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Trasteros cedidos: mejoras (e2e)', () => {
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

  async function setup(slug: string, units = 3) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: units,
      pricePerUnit: 50,
    });
    await setTenantFeatureOverride(owner.slug, 'unit_cession', true);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, tenantId: tenant.id, ...f };
  }

  it('avisos al propietario por la campana, el móvil y el correo; nada a la persona', async () => {
    const s = await setup('cessimp-notices');
    const [a] = s.unitIds as [string];
    const email = `cessimp-${Date.now()}@example.test`;
    const customerId = await createCustomer(app, s.owner.accessToken, { email });
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ customerId, startsOn: dayFromToday(-40), months: 2 })
      .expect(201);
    await db.unitCession.update({
      where: { id: created.body.id as string },
      data: { endsOn: asDate(dayFromToday(-1)) },
    });

    await app.get(UnitCessionsService).sendNotices();
    const note = await db.notification.findFirstOrThrow({
      where: { tenantId: s.tenantId, type: 'unit.cession_expired' },
    });
    expect(note.link).toBe(`/units/${a}`);
    // Los avisos de las cesiones llegan también al móvil del equipo.
    expect(isStaffPushType('unit.cession_expired')).toBe(true);
    expect(isStaffPushType('unit.cession_expiring')).toBe(true);
    expect(isStaffPushType('unit.cession_review')).toBe(true);

    const mail = await waitForEmail(s.owner.email, { subjectIncludes: 'Ha vencido la cesión' });
    expect(mail.Text).toContain(`/units/${a}`);
    expect(mail.Text).toContain('venció el');

    // Ni comunicaciones ni correos al inquilino enlazado.
    expect(await db.communication.count({ where: { customerId } })).toBe(0);
    await expect(waitForEmail(email, { timeoutMs: 1500 })).rejects.toThrow();
  });

  it('página «Cesiones»: estados, búsqueda, terminadas, local y paginación', async () => {
    const s = await setup('cessimp-page', 4);
    const [a, b, c, d] = s.unitIds as [string, string, string, string];
    const cede = (unit: string, holderName: string, body: Record<string, unknown>) =>
      http()
        .post(`/units/${unit}/cession`)
        .set(s.auth)
        .send({ holderName, ...body })
        .expect(201);
    await cede(a, 'Ana Plazo', { months: 6 });
    const exp = await cede(b, 'Berta Vencida', { startsOn: dayFromToday(-40), months: 2 });
    await db.unitCession.update({
      where: { id: exp.body.id as string },
      data: { endsOn: asDate(dayFromToday(-3)) },
    });
    await cede(c, 'Carla Pronto', { endsOn: dayFromToday(10), noticeDays: 15 });
    await cede(d, 'Dora Terminada', { months: 1 });
    await http().post(`/units/${d}/cession/end`).set(s.auth).send({ status: 'available' });

    const page = async (q: string) =>
      (await http().get(`/cessions/page?${q}`).set(s.auth).expect(200)).body as {
        items: UnitCessionDto[];
        nextCursor: string | null;
      };
    const names = (p: { items: UnitCessionDto[] }) => p.items.map((x) => x.holderName).sort();

    expect(names(await page('status=active'))).toEqual([
      'Ana Plazo',
      'Berta Vencida',
      'Carla Pronto',
    ]);
    expect(names(await page('status=expired'))).toEqual(['Berta Vencida']);
    // 10 días con aviso de 15: vence pronto.
    expect(names(await page('status=expiring'))).toEqual(['Carla Pronto']);
    expect(names(await page('status=on_time'))).toEqual(['Ana Plazo']);
    const ended = await page('status=ended');
    expect(names(ended)).toEqual(['Dora Terminada']);
    expect(ended.items[0]).toMatchObject({ state: 'ended', endedUnitStatus: 'available' });
    expect(ended.items[0]!.endedByName).toBeTruthy();
    expect(names(await page('status=all'))).toHaveLength(4);
    expect(names(await page(`status=active&search=${encodeURIComponent('berta')}`))).toEqual([
      'Berta Vencida',
    ]);
    const unitCode = (await http().get(`/units/${a}`).set(s.auth).expect(200)).body.code as string;
    expect(names(await page(`status=active&search=${encodeURIComponent(unitCode)}`))).toContain(
      'Ana Plazo',
    );
    expect((await page(`status=active&facilityId=${s.facilityId}`)).items).toHaveLength(3);

    // Paginación por cursor sin repetir.
    const first = await page('status=active&limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await page(`status=active&limit=2&cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((x) => x.id);
    expect(new Set(all).size).toBe(3);
    const endedFirst = await page('status=all&limit=3');
    expect(endedFirst.items).toHaveLength(3);
    const endedSecond = await page(`status=all&limit=3&cursor=${endedFirst.nextCursor}`);
    expect(endedSecond.items).toHaveLength(1);

    // Respuesta de siempre de `GET /cessions` (array).
    const legacy = await http().get('/cessions').set(s.auth).expect(200);
    expect(Array.isArray(legacy.body)).toBe(true);
    expect(legacy.body).toHaveLength(3);
  });

  it('última entrada, ampliar en un clic y posponer el aviso de una vencida', async () => {
    const s = await setup('cessimp-last');
    const [a] = s.unitIds as [string];
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Elena', startsOn: dayFromToday(-40), months: 2 })
      .expect(201);
    const cessionId = created.body.id as string;
    expect(created.body.access.lastUsedAt).toBeNull();
    const credentialId = created.body.access.credentialId as string;

    const at = new Date(Date.now() - 2 * 3_600_000);
    await db.accessLog.create({
      data: {
        tenantId: s.tenantId,
        credentialId,
        method: 'pin',
        result: 'allowed',
        occurredAt: at,
      },
    });
    // Un intento denegado posterior no cuenta como entrada.
    await db.accessLog.create({
      data: {
        tenantId: s.tenantId,
        credentialId,
        method: 'pin',
        result: 'denied_invalid_credential',
      },
    });
    const view = await http().get(`/units/${a}/cession`).set(s.auth).expect(200);
    expect(view.body.cession.access.lastUsedAt).toBe(at.toISOString());
    const listed = await http().get('/cessions/page?status=active').set(s.auth).expect(200);
    expect(listed.body.items[0].access.lastUsedAt).toBe(at.toISOString());

    // Vencida: posponer la saca de «Hoy» y no avisa mientras dure.
    await db.unitCession.update({
      where: { id: cessionId },
      data: { endsOn: asDate(dayFromToday(-2)) },
    });
    const notOnTime = await http()
      .post(`/units/${a}/cession/snooze`)
      .set(s.auth)
      .send({ days: 10 })
      .expect(400);
    expect(JSON.stringify(notOnTime.body)).toContain('7 o 30');
    const snoozed = await http()
      .post(`/units/${a}/cession/snooze`)
      .set(s.auth)
      .send({ days: 7 })
      .expect(200);
    expect(snoozed.body.snoozedUntil).toBeTruthy();
    const today = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today.body.cessionsExpired.count).toBe(0);
    await app.get(UnitCessionsService).sendNotices();
    expect(
      await db.notification.count({
        where: { tenantId: s.tenantId, type: 'unit.cession_expired' },
      }),
    ).toBe(0);
    // Pasado el plazo, avisa otra vez una sola vez.
    await db.unitCession.update({
      where: { id: cessionId },
      data: { snoozedUntil: new Date(Date.now() - 1000) },
    });
    await app.get(UnitCessionsService).sendNotices();
    await app.get(UnitCessionsService).sendNotices();
    const again = await db.notification.findMany({
      where: { tenantId: s.tenantId, type: 'unit.cession_expired' },
    });
    expect(again).toHaveLength(1);
    expect(again[0]!.title).toContain('Sigue vencida');

    // +1 mes desde «Hoy»: cuenta desde hoy porque ya había vencido.
    const extended = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ months: 1 })
      .expect(200);
    expect(extended.body.expired).toBe(false);
    expect(extended.body.snoozedUntil).toBeNull();
    const today2 = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today2.body.cessionsExpired.count).toBe(0);
  });

  it('pasar a contrato: termina, deja el trastero libre y no avisa a la lista de espera', async () => {
    const s = await setup('cessimp-contract');
    const [a, b] = s.unitIds as [string, string];
    const customerId = await createCustomer(app, s.owner.accessToken);
    const unitA = await db.unit.findUniqueOrThrow({ where: { id: a } });
    const entry = await db.waitlistEntry.create({
      data: {
        tenantId: s.tenantId,
        facilityId: unitA.facilityId,
        unitTypeId: unitA.unitTypeId,
        contactName: 'Persona en cola',
        contactEmail: `cola-${Date.now()}@example.test`,
      },
    });
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ customerId, months: 3 })
      .expect(201);
    const credentialId = created.body.access.credentialId as string;

    const res = await http().post(`/units/${a}/cession/to-contract`).set(s.auth).expect(200);
    expect(res.body.url).toBe(`/contracts/new?unitId=${a}&customerId=${customerId}`);
    expect(res.body.cession).toMatchObject({ state: 'ended', endedReason: 'Pasa a contrato' });
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('available');
    expect(
      (await db.accessCredential.findUniqueOrThrow({ where: { id: credentialId } })).status,
    ).toBe('revoked');
    await sleep(1500);
    expect((await db.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe(
      'waiting',
    );

    // Control: terminar otra cesión dejándolo libre sí avisa a la cola.
    await http().post(`/units/${b}/cession`).set(s.auth).send({ holderName: 'Fede', months: 1 });
    await http().post(`/units/${b}/cession/end`).set(s.auth).send({ status: 'available' });
    let status = 'waiting';
    for (let i = 0; i < 40 && status === 'waiting'; i++) {
      await sleep(150);
      status = (await db.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status;
    }
    expect(status).toBe('notified');
  });

  it('sin fecha de fin: no vence y se recuerda cada N meses una vez', async () => {
    const s = await setup('cessimp-open');
    const [a] = s.unitIds as [string];
    const bad = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Gema', openEnded: true, months: 2 })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('una de las tres');
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({
        holderName: 'Gema',
        startsOn: dayFromToday(-200),
        openEnded: true,
        reviewEveryMonths: 3,
      })
      .expect(201);
    expect(created.body).toMatchObject({
      endsOn: null,
      daysLeft: null,
      expired: false,
      state: 'on_time',
      reviewEveryMonths: 3,
    });
    const unit = await http().get(`/units/${a}`).set(s.auth).expect(200);
    expect(unit.body.cession).toMatchObject({ endsOn: null, expired: false });
    const cessions = app.get(UnitCessionsService);
    // Recién creada no se recuerda (cuenta desde hoy, no desde el inicio).
    expect((await cessions.sendNotices()).reviews).toBe(0);

    await db.unitCession.update({
      where: { id: created.body.id as string },
      data: { lastReviewNotifiedAt: new Date(Date.now() - 95 * DAY) },
    });
    const first = await cessions.sendNotices();
    expect(first.reviews).toBeGreaterThanOrEqual(1);
    await cessions.sendNotices();
    const reviews = await db.notification.findMany({
      where: { tenantId: s.tenantId, type: 'unit.cession_review' },
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.title).toContain('Sigue cedido el trastero');
    expect(reviews[0]!.title).toContain('desde hace 6 meses');
    await waitForEmail(s.owner.email, { subjectIncludes: 'Sigue cedido el trastero' });
    const today = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today.body.cessionsExpiring.count + today.body.cessionsExpired.count).toBe(0);

    // Ponerle fecha después; y otra vez sin fecha.
    const dated = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ months: 2 })
      .expect(200);
    expect(dated.body.endsOn).toBe(addMonths(madridToday(), 2));
    expect(dated.body.reviewEveryMonths).toBeNull();
    const reviewOnDated = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ reviewEveryMonths: 6 })
      .expect(400);
    expect(reviewOnDated.body.code).toBe('review_needs_open_ended');
    const reopened = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ openEnded: true, reviewEveryMonths: 12 })
      .expect(200);
    expect(reopened.body).toMatchObject({ endsOn: null, reviewEveryMonths: 12 });
  });

  it('el plazo de aviso elegido manda en los avisos y en «Hoy»', async () => {
    const s = await setup('cessimp-noticedays');
    const [a, b] = s.unitIds as [string, string];
    // 10 días con aviso de 3: aún no avisa.
    const short = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Hugo', endsOn: dayFromToday(10), noticeDays: 3 })
      .expect(201);
    expect(short.body).toMatchObject({ noticeDays: 3, state: 'on_time' });
    // 20 días con aviso de 30: ya dentro, pero quien la crea acaba de elegirla.
    await http()
      .post(`/units/${b}/cession`)
      .set(s.auth)
      .send({ holderName: 'Irene', endsOn: dayFromToday(20), noticeDays: 30 })
      .expect(201);
    const today = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today.body.cessionsExpiring.count).toBe(1);
    await app.get(UnitCessionsService).sendNotices();
    expect(
      await db.notification.count({
        where: { tenantId: s.tenantId, type: 'unit.cession_expiring' },
      }),
    ).toBe(0);

    // Pasa a avisar con 15 días: el cron avisa.
    await http().patch(`/units/${a}/cession`).set(s.auth).send({ noticeDays: 15 }).expect(200);
    await app.get(UnitCessionsService).sendNotices();
    expect(
      await db.notification.count({
        where: { tenantId: s.tenantId, type: 'unit.cession_expiring' },
      }),
    ).toBe(1);
    const bad = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ noticeDays: 5 })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('0, 3, 7, 15 o 30');
  });

  it('acceso 24 h y otro código: se ven, se cambian y se deniegan por separado y se revocan juntos', async () => {
    const s = await setup('cessimp-codes');
    const [a] = s.unitIds as [string];
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Julia', months: 3 })
      .expect(201);
    const primaryId = created.body.access.credentialId as string;

    const bypass = await http()
      .patch(`/units/${a}/cession/access`)
      .set(s.auth)
      .send({ bypassCurfew: true })
      .expect(200);
    expect(bypass.body.access.bypassCurfew).toBe(true);
    expect(
      (await db.accessCredential.findUniqueOrThrow({ where: { id: primaryId } })).bypassCurfew,
    ).toBe(true);

    const second = await http()
      .post(`/units/${a}/cession/access/codes`)
      .set(s.auth)
      .send({ label: 'Su pareja' })
      .expect(201);
    const secondId = second.body.credentialId as string;
    expect(second.body.code).toMatch(/^\d{6,8}$/);
    const secondRow = await db.accessCredential.findUniqueOrThrow({ where: { id: secondId } });
    expect(secondRow).toMatchObject({ label: 'Su pareja', bypassCurfew: true, customerId: null });
    expect(secondRow.allowedUnitIds).toEqual([a]);

    const view = await http().get(`/units/${a}/cession`).set(s.auth).expect(200);
    const codes = view.body.cession.codes as { credentialId: string; primary: boolean }[];
    expect(codes.map((c) => c.credentialId)).toEqual([primaryId, secondId]);
    expect(codes[0]!.primary).toBe(true);

    const seen = await http()
      .get(`/units/${a}/cession/access/codes/${secondId}/code`)
      .set(s.auth)
      .expect(200);
    expect(seen.body.code).toBe(second.body.code);
    const rotated = await http()
      .post(`/units/${a}/cession/access/codes/${secondId}/rotate`)
      .set(s.auth)
      .expect(200);
    expect(rotated.body.code).not.toBe(second.body.code);
    await http()
      .post(`/units/${a}/cession/access/codes/${secondId}/suspend`)
      .set(s.auth)
      .expect(200);
    const after = await db.accessCredential.findMany({
      where: { id: { in: [primaryId, secondId] } },
    });
    expect(after.find((c) => c.id === secondId)!.status).toBe('suspended');
    expect(after.find((c) => c.id === primaryId)!.status).toBe('active');
    await http()
      .post(`/units/${a}/cession/access/codes/${secondId}/resume`)
      .set(s.auth)
      .expect(200);
    await http()
      .patch(`/units/${a}/cession/access/codes/${secondId}`)
      .set(s.auth)
      .send({ bypassCurfew: false })
      .expect(200);
    // El principal no se quita; un código de otra cesión no vale.
    const removePrimary = await http()
      .delete(`/units/${a}/cession/access/codes/${primaryId}`)
      .set(s.auth)
      .expect(400);
    expect(removePrimary.body.code).toBe('cession_primary_code');
    const foreign = await http()
      .get(`/units/${a}/cession/access/codes/${'0'.repeat(8)}-0000-4000-8000-000000000000/code`)
      .set(s.auth)
      .expect(404);
    expect(foreign.body.code).toBe('cession_code_not_found');
    // Desde Accesos no se tocan.
    const blocked = await http()
      .post(`/access/credentials/${secondId}/suspend`)
      .set(s.auth)
      .send({ reason: 'x' });
    expect(blocked.status).toBe(409);

    await http().post(`/units/${a}/cession/end`).set(s.auth).send({ status: 'available' });
    const final = await db.accessCredential.findMany({
      where: { id: { in: [primaryId, secondId] } },
    });
    expect(final.map((c) => c.status)).toEqual(['revoked', 'revoked']);
  });

  it('el repaso de huérfanos revoca también el segundo código', async () => {
    const s = await setup('cessimp-orphan');
    const [a] = s.unitIds as [string];
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Kike', months: 3 })
      .expect(201);
    const second = await http()
      .post(`/units/${a}/cession/access/codes`)
      .set(s.auth)
      .send({})
      .expect(201);
    // La cesión se cierra sin pasar por el servicio (los códigos se quedan).
    await db.unitCession.update({
      where: { id: created.body.id as string },
      data: { endedAt: new Date() },
    });
    await app.get(AccessCredentialsService).sweep();
    const rows = await db.accessCredential.findMany({
      where: { id: { in: [created.body.access.credentialId, second.body.credentialId] } },
    });
    expect(rows.map((r) => r.status)).toEqual(['revoked', 'revoked']);
  });

  it('descuadres: cedido sin cesión y cesión viva con el trastero en otro estado', async () => {
    const s = await setup('cessimp-inventory');
    const [a, b] = s.unitIds as [string, string];
    // Cedido sin cesión: se corrige a disponible.
    await db.unit.update({ where: { id: a }, data: { status: 'ceded' } });
    // Cesión viva con el trastero en mantenimiento: hay que ir a la ficha.
    await http().post(`/units/${b}/cession`).set(s.auth).send({ holderName: 'Luis', months: 2 });
    await db.unit.update({ where: { id: b }, data: { status: 'maintenance' } });

    const issues = await http().get('/inventory/issues').set(s.auth).expect(200);
    const byUnit = new Map(
      (issues.body as { unitId: string }[]).map((i) => [i.unitId, i as Record<string, unknown>]),
    );
    expect(byUnit.get(a)).toMatchObject({
      currentStatus: 'ceded',
      expectedStatus: 'available',
      fixable: true,
      link: null,
    });
    expect(byUnit.get(b)).toMatchObject({
      currentStatus: 'maintenance',
      expectedStatus: 'ceded',
      fixable: false,
      link: `/units/${b}`,
    });
    const notFixable = await http().post(`/inventory/issues/${b}/fix`).set(s.auth).expect(409);
    expect(notFixable.body.code).toBe('inventory_issue_needs_action');
    await http().post(`/inventory/issues/${a}/fix`).set(s.auth).expect(200);
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('available');
  });
});

function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
