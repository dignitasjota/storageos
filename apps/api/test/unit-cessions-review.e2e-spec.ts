import { PrismaClient } from '@storageos/database';
import { addMonthsToDay } from '@storageos/shared';
import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { UnitCessionsService } from '../src/modules/unit-cessions/unit-cessions.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de los trasteros cedidos: fechas, el último día en plazo, ampliar
 * una vencida, mensajes, borrar un local, crear el acceso después, el repaso de
 * códigos huérfanos, avisos de una cesión corta y la impersonación.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
/** Día AAAA-MM-DD a N días de hoy (en hora de Madrid, como los locales). */
const dayFromToday = (offset: number) => {
  const [y, m, d] = madridToday().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
};
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

describe('Trasteros cedidos: revisión (e2e)', () => {
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
    await cleanupSuperAdmins();
    await cleanupTestTenants();
  });

  async function setup(slug: string, units = 2) {
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

  it('fechas imposibles, inicio futuro e inicio pasado que la dejaría vencida: 400', async () => {
    const s = await setup('cessrv-dates');
    const [a] = s.unitIds as [string];
    const post = (body: Record<string, unknown>) =>
      http()
        .post(`/units/${a}/cession`)
        .set(s.auth)
        .send({ holderName: 'Ana', ...body });

    const feb31 = await post({ endsOn: '2027-02-31' });
    expect(feb31.status).toBe(400);
    expect(JSON.stringify(feb31.body)).toContain('Esa fecha no existe');
    expect((await post({ startsOn: '2026-13-01', months: 1 })).status).toBe(400);

    const future = await post({ startsOn: dayFromToday(3), months: 1 });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('invalid_starts_on');

    const stale = await post({ startsOn: dayFromToday(-90), months: 1 });
    expect(stale.status).toBe(400);
    expect(stale.body.code).toBe('cession_already_expired');

    // Nada se ha cedido.
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('available');
    // Un inicio pasado con un plazo que llega a hoy sí vale.
    await post({ startsOn: dayFromToday(-10), months: 1 }).expect(201);
  });

  it('el día de fin aún está en plazo; vencida desde el día siguiente', async () => {
    const s = await setup('cessrv-lastday');
    const [a] = s.unitIds as [string];
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', startsOn: dayFromToday(-60), months: 3 })
      .expect(201);
    const cessionId = created.body.id as string;
    await db.unitCession.update({
      where: { id: cessionId },
      data: { endsOn: asDate(madridToday()) },
    });

    const view = await http().get(`/units/${a}/cession`).set(s.auth).expect(200);
    expect(view.body.cession).toMatchObject({ daysLeft: 0, expired: false });
    const unit = await http().get(`/units/${a}`).set(s.auth).expect(200);
    expect(unit.body.cession.expired).toBe(false);
    const expiring = await http().get('/cessions?status=expiring').set(s.auth).expect(200);
    expect((expiring.body as { id: string }[]).map((c) => c.id)).toContain(cessionId);
    const expired = await http().get('/cessions?status=expired').set(s.auth).expect(200);
    expect(expired.body).toHaveLength(0);
    const today = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today.body.cessionsExpiring.count).toBe(1);
    expect(today.body.cessionsExpired.count).toBe(0);

    const cessions = app.get(UnitCessionsService);
    await cessions.sendNotices();
    const notes = await db.notification.findMany({ where: { tenantId: s.tenantId } });
    expect(notes.map((n) => n.type)).toEqual(['unit.cession_expiring']);
    expect(notes[0]!.title).toContain('vence hoy');

    // Al día siguiente, vencida.
    await db.unitCession.update({
      where: { id: cessionId },
      data: { endsOn: asDate(dayFromToday(-1)) },
    });
    const after = await http().get(`/units/${a}/cession`).set(s.auth).expect(200);
    expect(after.body.cession).toMatchObject({ daysLeft: -1, expired: true });
    const today2 = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today2.body.cessionsExpired.count).toBe(1);
    expect(today2.body.cessionsExpiring.count).toBe(0);
    await cessions.sendNotices();
    const expiredNote = await db.notification.findFirstOrThrow({
      where: { tenantId: s.tenantId, type: 'unit.cession_expired' },
    });
    expect(expiredNote.body).toContain('Venció el');
  });

  it('ampliar por meses cuenta desde hoy si ya había vencido, y desde el fin si no', async () => {
    const s = await setup('cessrv-extend');
    const [a] = s.unitIds as [string];
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', startsOn: dayFromToday(-60), months: 3 })
      .expect(201);
    const cessionId = created.body.id as string;

    await db.unitCession.update({
      where: { id: cessionId },
      data: { endsOn: asDate(dayFromToday(-40)) },
    });
    const fromToday = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ months: 1 })
      .expect(200);
    expect(fromToday.body.endsOn).toBe(addMonthsToDay(madridToday(), 1));
    expect(fromToday.body.expired).toBe(false);

    const fromEnd = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ months: 1 })
      .expect(200);
    expect(fromEnd.body.endsOn).toBe(addMonthsToDay(addMonthsToDay(madridToday(), 1), 1));

    // A una fecha dentro de la semana: el «vence pronto» no salta al momento.
    await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ endsOn: dayFromToday(3) })
      .expect(200);
    const row = await db.unitCession.findUniqueOrThrow({ where: { id: cessionId } });
    expect(row.expiringNotifiedAt).not.toBeNull();
    expect(row.expiredNotifiedAt).toBeNull();
    // Y una fecha pasada no vale.
    const past = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ endsOn: dayFromToday(-1) });
    expect(past.status).toBe(400);
  });

  it('una cesión corta no avisa al crearla de que vence pronto, pero sí al vencer', async () => {
    const s = await setup('cessrv-short');
    const [a] = s.unitIds as [string];
    await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', endsOn: dayFromToday(3) })
      .expect(201);
    const cessions = app.get(UnitCessionsService);
    await cessions.sendNotices();
    expect(await db.notification.count({ where: { tenantId: s.tenantId } })).toBe(0);
    await cessions.sendNotices(new Date(Date.now() + 5 * DAY));
    const notes = await db.notification.findMany({ where: { tenantId: s.tenantId } });
    expect(notes.map((n) => n.type)).toEqual(['unit.cession_expired']);
  });

  it('reservar un cedido da un mensaje en español; ceder y reservar a la vez, solo uno', async () => {
    const s = await setup('cessrv-reserve', 3);
    const [ceded, race] = s.unitIds as [string, string];
    const customerId = await createCustomer(app, s.owner.accessToken);
    await http()
      .post(`/units/${ceded}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    const reservation = (unitId: string) =>
      http()
        .post('/reservations')
        .set(s.auth)
        .send({
          customerId,
          unitId,
          validFrom: new Date().toISOString(),
          validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
          confirmImmediately: true,
        });
    const r = await reservation(ceded);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      code: 'unit_not_reservable',
      message: 'Este trastero está cedido: no se puede reservar',
    });

    const [cession, reserved] = await Promise.all([
      http().post(`/units/${race}/cession`).set(s.auth).send({ holderName: 'Luis', months: 1 }),
      reservation(race),
    ]);
    const ok = [cession.status, reserved.status].filter((st) => st === 201);
    expect(ok).toHaveLength(1);
    const unit = await db.unit.findUniqueOrThrow({ where: { id: race } });
    expect(unit.status).toBe(cession.status === 201 ? 'ceded' : 'reserved');
  });

  it('no se borra un local con trasteros cedidos', async () => {
    const s = await setup('cessrv-delete');
    const [a] = s.unitIds as [string];
    await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    const preview = await http()
      .get(`/facilities/${s.facilityId}/delete-preview`)
      .set(s.auth)
      .expect(200);
    expect(preview.body.blockers).toContainEqual({
      kind: 'ceded_units',
      count: 1,
      label: '1 trastero cedido',
      href: `/units?status=ceded&facilityId=${s.facilityId}`,
    });
    const del = await http().delete(`/facilities/${s.facilityId}`).set(s.auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('facility_has_pending');

    await http().post(`/units/${a}/cession/end`).set(s.auth).send({}).expect(200);
    await http().delete(`/facilities/${s.facilityId}`).set(s.auth).expect(204);
  });

  it('una cesión sin acceso puede tenerlo después', async () => {
    const s = await setup('cessrv-access');
    const [a] = s.unitIds as [string];
    await setTenantFeatureOverride(s.owner.slug, 'access_control', false);
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    expect(created.body.access).toBeNull();

    const noFeature = await http().post(`/units/${a}/cession/access`).set(s.auth);
    expect(noFeature.status).toBe(403);
    expect(noFeature.body.code).toBe('feature_not_in_plan');

    await setTenantFeatureOverride(s.owner.slug, 'access_control', true);
    const withAccess = await http().post(`/units/${a}/cession/access`).set(s.auth).expect(201);
    expect(withAccess.body.access).toMatchObject({ status: 'active' });
    const cred = await db.accessCredential.findUniqueOrThrow({
      where: { id: withAccess.body.access.credentialId },
    });
    expect(cred).toMatchObject({ allowedUnitIds: [a], customerId: null });
    expect(cred.metadata).toMatchObject({ source: 'unit_cession', cessionId: created.body.id });
    await http().get(`/units/${a}/cession/access/code`).set(s.auth).expect(200);

    const again = await http().post(`/units/${a}/cession/access`).set(s.auth);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('cession_has_access');
  });

  it('el repaso revoca el código de una cesión terminada que se quedó activo', async () => {
    const s = await setup('cessrv-sweep');
    const [a, b] = s.unitIds as [string, string];
    const ended = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    const live = await http()
      .post(`/units/${b}/cession`)
      .set(s.auth)
      .send({ holderName: 'Luis', months: 1 })
      .expect(201);
    // Simula una retirada fallida: la cesión terminada y su código activo.
    await db.unitCession.update({
      where: { id: ended.body.id },
      data: { endedAt: new Date(), endedUnitStatus: 'available' },
    });
    await app.get(AccessCredentialsService).sweep();
    const orphan = await db.accessCredential.findUniqueOrThrow({
      where: { id: ended.body.access.credentialId },
    });
    expect(orphan.status).toBe('revoked');
    const kept = await db.accessCredential.findUniqueOrThrow({
      where: { id: live.body.access.credentialId },
    });
    expect(kept.status).toBe('active');
  });

  it('durante una impersonación no se ve ni se cambia el código, y ver el código guarda la IP', async () => {
    const s = await setup('cessrv-imp');
    const [a] = s.unitIds as [string];
    await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);

    await http()
      .get(`/units/${a}/cession/access/code`)
      .set(s.auth)
      .set('User-Agent', 'cessrv-agent')
      .expect(200);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId: s.tenantId, action: 'access.code_viewed' },
    });
    expect(audit.userAgent).toBe('cessrv-agent');
    expect(audit.ipAddress).not.toBeNull();

    const sa = await seedSuperAdmin('cessrv-imp');
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password });
    const saAuth = { Authorization: `Bearer ${login.body.accessToken}` };
    const imp = await http()
      .post(`/admin/tenants/${s.tenantId}/impersonate`)
      .set(saAuth)
      .send({ reason: 'revisar cesiones', readOnly: false });
    expect(imp.status).toBe(200);
    const impAuth = { Authorization: `Bearer ${imp.body.accessToken}` };

    const code = await http().get(`/units/${a}/cession/access/code`).set(impAuth);
    expect(code.status).toBe(403);
    expect(code.body.code).toBe('not_allowed_while_impersonating');
    const rotate = await http().post(`/units/${a}/cession/access/rotate`).set(impAuth);
    expect(rotate.status).toBe(403);
    expect(rotate.body.code).toBe('not_allowed_while_impersonating');
    // Ver la cesión sí.
    await http().get(`/units/${a}/cession`).set(impAuth).expect(200);
  });
});
