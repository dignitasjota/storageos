import { PrismaClient } from '@storageos/database';
import { addMonthsToDay } from '@storageos/shared';
import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { UnitCessionsService } from '../src/modules/unit-cessions/unit-cessions.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Trasteros cedidos: el propietario presta un trastero sin contrato ni cobro.
 * Cuenta como un trastero en mantenimiento, tiene un PIN que solo ve el
 * propietario, no se comunica nada a la persona y al vencer solo se avisa.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const madridToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

describe('Trasteros cedidos (e2e)', () => {
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

  async function setup(slug: string, opts: { feature?: boolean; units?: number } = {}) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: opts.units ?? 2,
      pricePerUnit: 50,
    });
    if (opts.feature !== false) await setTenantFeatureOverride(owner.slug, 'unit_cession', true);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, tenantId: tenant.id, ...f };
  }

  it('sin la función no se puede ceder; con ella el propietario cede por meses y por fecha', async () => {
    const s = await setup('cess-basic', { feature: false });
    const [a, b] = s.unitIds as [string, string];

    const denied = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana Amiga', months: 3 });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('feature_not_in_plan');

    await setTenantFeatureOverride(s.owner.slug, 'unit_cession', true);
    const byMonths = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana Amiga', holderPhone: '600111222', months: 3, notes: 'Mudanza' })
      .expect(201);
    const today = madridToday();
    expect(byMonths.body).toMatchObject({
      holderName: 'Ana Amiga',
      startsOn: today,
      endsOn: addMonthsToDay(today, 3),
      expired: false,
      unitPriceMonthly: 50,
      previousUnitStatus: 'available',
    });
    // Starter tiene control de accesos: la cesión lleva su PIN.
    expect(byMonths.body.access).toMatchObject({ status: 'active' });

    const unit = await http().get(`/units/${a}`).set(s.auth).expect(200);
    expect(unit.body.status).toBe('ceded');
    expect(unit.body.cession).toMatchObject({ holderName: 'Ana Amiga', expired: false });

    // Otra vez el mismo trastero: ya está cedido.
    const again = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Otra', months: 1 });
    expect(again.status).toBe(409);

    // Por fecha, a un inquilino (su nombre se copia).
    const customerId = await createCustomer(app, s.owner.accessToken, {
      firstName: 'Luis',
      lastName: 'Pérez',
    });
    const endsOn = isoDay(40);
    const byDate = await http()
      .post(`/units/${b}/cession`)
      .set(s.auth)
      .send({ customerId, endsOn })
      .expect(201);
    expect(byDate.body).toMatchObject({ customerId, holderName: 'Luis Pérez', endsOn });
    const byCustomer = await http().get(`/cessions?customerId=${customerId}`).set(s.auth);
    expect(byCustomer.body).toHaveLength(1);

    // Sin plazo, o con los dos, 400.
    const c2 = await createFacilityWithUnits(app, s.owner.accessToken, { unitsCount: 1 });
    await http()
      .post(`/units/${c2.unitIds[0]}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana' })
      .expect(400);
    await http()
      .post(`/units/${c2.unitIds[0]}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 2, endsOn })
      .expect(400);

    // El cambio de estado genérico no saca un trastero de «Cedido» ni lo pone.
    const generic = await http()
      .post(`/units/${a}/change-status`)
      .set(s.auth)
      .send({ status: 'available' });
    expect(generic.status).toBe(409);
    expect(generic.body.code).toBe('unit_ceded');
    const toCeded = await http()
      .post(`/units/${c2.unitIds[0]}/change-status`)
      .set(s.auth)
      .send({ status: 'ceded' });
    expect(toCeded.status).toBe(400);

    // Historial del trastero y registro de actividad.
    const history = await http().get(`/units/${a}/history`).set(s.auth).expect(200);
    expect(history.body[0]).toMatchObject({ previousStatus: 'available', newStatus: 'ceded' });
    const audits = await db.auditLog.count({
      where: { tenantId: s.tenantId, action: 'unit.ceded' },
    });
    expect(audits).toBe(2);
  });

  it('solo el propietario cede y termina; un gestor ve la cesión', async () => {
    const s = await setup('cess-roles');
    const [a, b] = s.unitIds as [string, string];
    const manager = await scopedUser(app, s.owner, {
      role: 'manager',
      facilityIds: [s.facilityId],
      tag: 'cessmgr',
    });

    const create = await http()
      .post(`/units/${a}/cession`)
      .set(manager)
      .send({ holderName: 'Ana', months: 1 });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('owner_only');

    await http()
      .post(`/units/${b}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    const seen = await http().get(`/units/${b}/cession`).set(manager).expect(200);
    expect(seen.body.cession).toMatchObject({ holderName: 'Ana' });
    await http().get(`/cessions`).set(manager).expect(200);

    expect((await http().post(`/units/${b}/cession/end`).set(manager).send({})).status).toBe(403);
    expect(
      (await http().patch(`/units/${b}/cession`).set(manager).send({ months: 1 })).status,
    ).toBe(403);
    expect((await http().get(`/units/${b}/cession/access/code`).set(manager)).status).toBe(403);
  });

  it('no se cede un trastero alquilado o reservado, y uno cedido no se vende ni cuenta', async () => {
    const s = await setup('cess-avail', { units: 4 });
    const [rented, reserved, ceded, free] = s.unitIds as [string, string, string, string];
    const customerId = await createCustomer(app, s.owner.accessToken);

    const contract = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: rented, startDate: isoDay(-10), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(s.auth).send({}).expect(200);
    const r1 = await http()
      .post(`/units/${rented}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 });
    expect(r1.status).toBe(409);

    await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        customerId,
        unitId: reserved,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    const r2 = await http()
      .post(`/units/${reserved}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 });
    expect(r2.status).toBe(409);

    const before = await http().get('/dashboard/occupancy').set(s.auth).expect(200);
    await http()
      .post(`/units/${ceded}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);

    // Fuera de la reserva online y de la web pública: solo queda `free`.
    const avail = await http().get(`/public/move-in/book/${s.owner.slug}/availability`);
    expect(avail.status).toBe(200);
    const facility = avail.body.facilities.find((f: { id: string }) => f.id === s.facilityId);
    expect(facility.unitTypes[0].available).toBe(1);
    const landing = await http().get(`/public/landing/${s.owner.slug}`).expect(200);
    const fac = landing.body.facilities.find((f: { id: string }) => f.id === s.facilityId);
    expect(fac.unitTypes[0].available).toBe(1);

    // Ni contrato ni reserva sobre el cedido.
    const c = await http()
      .post('/contracts')
      .set(s.auth)
      .send({ customerId, unitId: ceded, startDate: isoDay(0), priceMonthly: 50 });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('unit_ceded');
    const r = await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        customerId,
        unitId: ceded,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
      });
    expect(r.status).toBe(409);

    // Cuenta como un trastero en mantenimiento: total igual, ocupados igual.
    const after = await http().get('/dashboard/occupancy').set(s.auth).expect(200);
    expect(after.body.totalUnits).toBe(before.body.totalUnits);
    expect(after.body.byStatus.ceded).toBe(1);
    expect(after.body.byStatus.available).toBe(before.body.byStatus.available - 1);
    const facAfter = after.body.byFacility.find(
      (f: { facilityId: string }) => f.facilityId === s.facilityId,
    );
    expect(facAfter.occupiedUnits).toBe(1);

    // El inventario no lo toma por un descuadre.
    const issues = await http().get('/inventory/issues').set(s.auth).expect(200);
    expect((issues.body as { unitId: string }[]).some((i) => i.unitId === ceded)).toBe(false);
    void free;
  });

  it('ampliar, el acceso solo para el propietario, sin comunicaciones, avisos y terminar', async () => {
    const s = await setup('cess-flow');
    const [a] = s.unitIds as [string, string];
    const startsOn = isoDay(-30);
    const endsOn = isoDay(5);
    const created = await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana Amiga', startsOn, endsOn })
      .expect(201);
    const cessionId = created.body.id as string;
    const credentialId = created.body.access.credentialId as string;

    // La credencial: PIN sin caducidad, solo ese local y trastero, sin inquilino.
    const cred = await db.accessCredential.findUniqueOrThrow({ where: { id: credentialId } });
    expect(cred).toMatchObject({
      customerId: null,
      method: 'pin',
      status: 'active',
      expiresAt: null,
      holderName: 'Ana Amiga',
      allowedFacilityIds: [s.facilityId],
      allowedUnitIds: [a],
    });
    expect(cred.metadata).toMatchObject({ source: 'unit_cession', cessionId });

    // El código solo lo ve el propietario.
    const code = await http().get(`/units/${a}/cession/access/code`).set(s.auth).expect(200);
    expect(code.body.code).toMatch(/^\d{6,8}$/);
    const rotated = await http().post(`/units/${a}/cession/access/rotate`).set(s.auth).expect(200);
    expect(rotated.body.code).toMatch(/^\d{6,8}$/);
    expect(rotated.body.code).not.toBe(code.body.code);
    const suspended = await http()
      .post(`/units/${a}/cession/access/suspend`)
      .set(s.auth)
      .expect(200);
    expect(suspended.body.access.status).toBe('suspended');
    const resumed = await http().post(`/units/${a}/cession/access/resume`).set(s.auth).expect(200);
    expect(resumed.body.access.status).toBe('active');
    // Desde Accesos no se toca: es de la cesión.
    const generic = await http().post(`/access/credentials/${credentialId}/revoke`).set(s.auth);
    expect(generic.status).toBe(409);

    // Nada a la persona: ni comunicaciones ni contrato ni factura.
    expect(await db.communication.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await db.contract.count({ where: { tenantId: s.tenantId } })).toBe(0);
    expect(await db.invoice.count({ where: { tenantId: s.tenantId } })).toBe(0);

    // Aviso de los 7 días, una sola vez.
    const cessions = app.get(UnitCessionsService);
    const first = await cessions.sendNotices();
    expect(first.expiring).toBeGreaterThanOrEqual(1);
    await cessions.sendNotices();
    const expiringNotes = await db.notification.count({
      where: { tenantId: s.tenantId, type: 'unit.cession_expiring' },
    });
    expect(expiringNotes).toBe(1);
    const today1 = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today1.body.cessionsExpiring.count).toBe(1);

    // Al vencer: aviso de vencida una vez, ni se libera ni se revoca.
    const later = new Date(Date.now() + 8 * DAY);
    await cessions.sendNotices(later);
    await cessions.sendNotices(later);
    expect(
      await db.notification.count({
        where: { tenantId: s.tenantId, type: 'unit.cession_expired' },
      }),
    ).toBe(1);
    await db.unitCession.update({
      where: { id: cessionId },
      data: { endsOn: new Date(`${isoDay(-1)}T00:00:00Z`) },
    });
    const expiredView = await http().get(`/units/${a}/cession`).set(s.auth).expect(200);
    expect(expiredView.body.cession.expired).toBe(true);
    const today2 = await http().get('/dashboard/today').set(s.auth).expect(200);
    expect(today2.body.cessionsExpired.count).toBe(1);
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('ceded');
    // El repaso de credenciales no toca el acceso de una cesión viva.
    await app.get(AccessCredentialsService).sweep(later);
    expect(
      (await db.accessCredential.findUniqueOrThrow({ where: { id: credentialId } })).status,
    ).toBe('active');

    // Ampliar por meses (desde la fecha de fin, aunque ya pasara) y por fecha.
    const extended = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ months: 2 })
      .expect(200);
    expect(extended.body.endsOn).toBe(addMonthsToDay(isoDay(-1), 2));
    expect(extended.body.expired).toBe(false);
    const row = await db.unitCession.findUniqueOrThrow({ where: { id: cessionId } });
    expect(row.expiredNotifiedAt).toBeNull();
    expect(row.expiringNotifiedAt).toBeNull();
    const byDate = await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ endsOn: isoDay(90) })
      .expect(200);
    expect(byDate.body.endsOn).toBe(isoDay(90));
    await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ endsOn: isoDay(-60) })
      .expect(400);

    // Terminar: el trastero queda en mantenimiento y el acceso revocado.
    const ended = await http()
      .post(`/units/${a}/cession/end`)
      .set(s.auth)
      .send({ status: 'maintenance', reason: 'Pintar' })
      .expect(200);
    expect(ended.body).toMatchObject({ endedUnitStatus: 'maintenance' });
    expect(ended.body.endedAt).not.toBeNull();
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('maintenance');
    expect(
      (await db.accessCredential.findUniqueOrThrow({ where: { id: credentialId } })).status,
    ).toBe('revoked');
    expect((await http().get(`/units/${a}/cession`).set(s.auth)).body.cession).toBeNull();
    const all = await http().get(`/units/${a}/cessions`).set(s.auth).expect(200);
    expect(all.body).toHaveLength(1);
    expect(await db.communication.count({ where: { tenantId: s.tenantId } })).toBe(0);
  });

  it('con la función desactivada, una cesión viva se termina y su acceso se gestiona, pero no se amplía', async () => {
    const s = await setup('cess-off');
    const [a] = s.unitIds as [string, string];
    await http()
      .post(`/units/${a}/cession`)
      .set(s.auth)
      .send({ holderName: 'Ana', months: 1 })
      .expect(201);
    await setTenantFeatureOverride(s.owner.slug, 'unit_cession', false);

    const unit = await http().get(`/units/${a}`).set(s.auth).expect(200);
    expect(unit.body.status).toBe('ceded');
    const extend = await http().patch(`/units/${a}/cession`).set(s.auth).send({ months: 1 });
    expect(extend.status).toBe(403);
    expect(extend.body.code).toBe('feature_not_in_plan');
    await http()
      .patch(`/units/${a}/cession`)
      .set(s.auth)
      .send({ notes: 'Solo una nota' })
      .expect(200);
    await http().get(`/units/${a}/cession/access/code`).set(s.auth).expect(200);
    await http().post(`/units/${a}/cession/access/rotate`).set(s.auth).expect(200);
    await http().post(`/units/${a}/cession/access/suspend`).set(s.auth).expect(200);
    await http().post(`/units/${a}/cession/access/resume`).set(s.auth).expect(200);
    const ended = await http().post(`/units/${a}/cession/end`).set(s.auth).send({}).expect(200);
    expect(ended.body.endedUnitStatus).toBe('available');
    expect((await db.unit.findUniqueOrThrow({ where: { id: a } })).status).toBe('available');
  });
});
