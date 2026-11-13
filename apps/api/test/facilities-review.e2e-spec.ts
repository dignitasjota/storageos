import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { RecurringExpensesService } from '../src/modules/expenses/recurring-expenses.service';
import { FilesService } from '../src/modules/files/files.service';
import { FacilityDocumentsExpiryCron } from '../src/modules/inventory/facility-documents-expiry.cron';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Locales: borrar dice qué falta y apaga lo automático, un local
 * borrado deja de actuar, quien solo ve unos locales ve el que crea, las cifras
 * cuadran con el Resumen y el dinero se oculta a quien no tiene permiso.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('Revisión de Locales (e2e)', () => {
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

  async function setup(slug: string, unitsCount = 2) {
    const owner = await registerVerifiedUser(app, slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const f = await createFacilityWithUnits(app, owner.accessToken, { unitsCount });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, tenantId: tenant.id, ...f };
  }

  const draft = async (auth: Record<string, string>, token: string, unitId: string) => {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(-30), priceMonthly: 50 })
      .expect(201);
    return { id: c.body.id as string, customerId };
  };

  const signed = async (auth: Record<string, string>, token: string, unitId: string) => {
    const c = await draft(auth, token, unitId);
    await http().post(`/contracts/${c.id}/sign`).set(auth).send({}).expect(200);
    return c;
  };

  /** Invita a alguien y devuelve su token y su id. */
  async function invite(ownerAuth: Record<string, string>, tenantSlug: string, role: string) {
    const email = `fac-${role}-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(ownerAuth).send({ email, role }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Persona Equipo', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const user = (users.body as { id: string; email: string }[]).find((x) => x.email === email)!;
    const login = async () => {
      const res = await http()
        .post('/auth/login')
        .send({ tenantSlug, email, password: 'Passw0rd!' });
      return { Authorization: `Bearer ${res.body.accessToken}` };
    };
    return { id: user.id, auth: await login(), login };
  }

  it('borrar dice qué falta y lo apaga todo; un local borrado deja de actuar', async () => {
    const s = await setup('fac-del', 3);
    const token = s.owner.accessToken;
    const other = await createFacilityWithUnits(app, token, { unitsCount: 2 });

    const pending = await draft(s.auth, token, s.unitIds[0]!);
    const reservation = await http()
      .post('/reservations')
      .set(s.auth)
      .send({
        unitId: s.unitIds[1],
        customerId: pending.customerId,
        validFrom: `${isoDay(1)}T10:00:00.000Z`,
        validUntil: `${isoDay(5)}T10:00:00.000Z`,
      })
      .expect(201);
    const queue = await http()
      .post('/waitlist')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        contactName: 'Ana',
        contactEmail: 'ana@example.com',
      })
      .expect(201);
    const moving = await signed(s.auth, token, other.unitIds[0]!);
    await http()
      .post(`/contracts/${moving.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: s.unitIds[2], effectiveDate: isoDay(7) })
      .expect(200);

    const preview = await http()
      .get(`/facilities/${s.facilityId}/delete-preview`)
      .set(s.auth)
      .expect(200);
    expect(preview.body.blockers.map((b: { kind: string }) => b.kind)).toEqual([
      'draft_contracts',
      'reservations',
      'scheduled_moves',
      'waitlist',
    ]);
    const refused = await http().delete(`/facilities/${s.facilityId}`).set(s.auth);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('facility_has_pending');
    expect(refused.body.message).toContain('1 contrato sin firmar');

    await http().post(`/contracts/${pending.id}/cancel`).set(s.auth).send({}).expect(200);
    await http()
      .post(`/reservations/${reservation.body.id}/cancel`)
      .set(s.auth)
      .send({ reason: 'prueba' })
      .expect(200);
    await http().delete(`/contracts/${moving.id}/scheduled-move`).set(s.auth).expect(200);
    await http()
      .patch(`/waitlist/${queue.body.id}`)
      .set(s.auth)
      .send({ status: 'cancelled' })
      .expect(200);

    const plan = await http()
      .post('/maintenance-plans')
      .set(s.auth)
      .send({
        title: 'Revisión',
        type: 'inspection',
        priority: 'high',
        freq: 'monthly',
        interval: 1,
        dayOfMonth: 1,
        startDate: isoDay(-40),
        facilityId: s.facilityId,
      })
      .expect(201);
    const expense = await http()
      .post('/expenses/recurring')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        category: 'rent',
        description: 'Alquiler de la nave',
        amount: 800,
        dayOfMonth: 1,
      })
      .expect(201);
    const device = await http()
      .post('/access/devices')
      .set(s.auth)
      .send({ facilityId: s.facilityId, type: 'gate', name: 'Cancela', hardwareId: 'fac-del-1' })
      .expect(201);

    const ready = await http()
      .get(`/facilities/${s.facilityId}/delete-preview`)
      .set(s.auth)
      .expect(200);
    expect(ready.body.blockers).toEqual([]);
    expect(ready.body.unitsCount).toBe(3);
    expect(ready.body.turnsOff).toEqual({
      maintenancePlans: 1,
      recurringExpenses: 1,
      accessDevices: 1,
      cameraDevices: 0,
    });

    await http().delete(`/facilities/${s.facilityId}`).set(s.auth).expect(204);

    expect(await db.maintenancePlan.findUnique({ where: { id: plan.body.id } })).toMatchObject({
      isActive: false,
    });
    expect(await db.recurringExpense.findUnique({ where: { id: expense.body.id } })).toMatchObject({
      active: false,
    });
    await http()
      .post('/access/verify')
      .set('X-Device-Key', device.body.revealedApiKey as string)
      .send({ method: 'pin', credential: '123456', deviceId: 'fac-del-1' })
      .expect(401);
    const open = await http().post(`/access/devices/${device.body.id}/open`).set(s.auth);
    expect(open.status).toBe(409);
    expect(open.body.code).toBe('device_inactive');
    await http()
      .post('/access/devices')
      .set(s.auth)
      .send({ facilityId: s.facilityId, type: 'gate', name: 'Otra', hardwareId: 'fac-del-2' })
      .expect(404);

    // Aunque quedara algo encendido (locales borrados antes de esto), no sigue actuando.
    await db.maintenancePlan.update({ where: { id: plan.body.id }, data: { isActive: true } });
    await db.recurringExpense.update({ where: { id: expense.body.id }, data: { active: true } });
    await db.accessDevice.update({ where: { id: device.body.id }, data: { isActive: true } });
    await app.get(MaintenanceService).generateDue();
    expect(await db.task.count({ where: { tenantId: s.tenantId } })).toBe(0);
    const generated = await app.get(RecurringExpensesService).generateForTenant(s.tenantId);
    expect(generated.created).toBe(0);
    await http()
      .post('/access/verify')
      .set('X-Device-Key', device.body.revealedApiKey as string)
      .send({ method: 'pin', credential: '123456', deviceId: 'fac-del-1' })
      .expect(401);

    // Un contrato a medias en un local ya borrado no se firma ni se traslada a él.
    const old = await createFacilityWithUnits(app, token, { unitsCount: 1 });
    const stale = await draft(s.auth, token, old.unitIds[0]!);
    await db.facility.update({ where: { id: old.facilityId }, data: { deletedAt: new Date() } });
    const sign = await http().post(`/contracts/${stale.id}/sign`).set(s.auth).send({});
    expect(sign.status).toBe(409);
    expect(sign.body.code).toBe('facility_deleted');
    const move = await http()
      .post(`/contracts/${moving.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: old.unitIds[0] });
    expect(move.status).toBe(404);
    const later = await http()
      .post(`/contracts/${moving.id}/change-unit`)
      .set(s.auth)
      .send({ newUnitId: old.unitIds[0], effectiveDate: isoDay(7) });
    expect(later.status).toBe(404);

    // El buscador encuentra locales y no enseña trasteros de los borrados.
    const units = await db.unit.findUniqueOrThrow({ where: { id: s.unitIds[0] } });
    const search = await http().get('/search').query({ q: units.code }).set(s.auth).expect(200);
    expect(search.body.results).toEqual([]);
    const name = await db.facility.findUniqueOrThrow({ where: { id: other.facilityId } });
    const found = await http().get('/search').query({ q: name.name }).set(s.auth).expect(200);
    expect(found.body.results[0]).toMatchObject({
      type: 'facility',
      href: `/facilities/${other.facilityId}`,
    });
  }, 60_000);

  it('quien solo ve unos locales ve el que crea, al momento y con su token', async () => {
    const s = await setup('fac-scope', 1);
    const a = s.facilityId;
    const b = await createFacilityWithUnits(app, s.owner.accessToken);
    const manager = await invite(s.auth, s.owner.slug, 'manager');
    await http()
      .patch(`/settings/users/${manager.id}/facilities`)
      .set(s.auth)
      .send({ facilityIds: [a] })
      .expect(204);

    // El alcance se lee en cada petición: no hay que volver a entrar.
    await http().get(`/facilities/${b.facilityId}`).set(manager.auth).expect(403);
    const created = await http()
      .post('/facilities')
      .set(manager.auth)
      .send({ name: 'Local del gestor', country: 'ES' })
      .expect(201);
    await http().get(`/facilities/${created.body.id}`).set(manager.auth).expect(200);
    const list = await http().get('/facilities').set(manager.auth).expect(200);
    expect(list.body.map((f: { id: string }) => f.id).sort()).toEqual([a, created.body.id].sort());

    await http()
      .patch(`/settings/users/${manager.id}/facilities`)
      .set(s.auth)
      .send({ facilityIds: [created.body.id] })
      .expect(204);
    await http().get(`/facilities/${a}`).set(manager.auth).expect(403);

    // Se avisa de quién se queda sin locales y, al borrar, no pasa a verlos todos.
    const preview = await http()
      .get(`/facilities/${created.body.id}/delete-preview`)
      .set(s.auth)
      .expect(200);
    expect(preview.body.usersLeftWithoutFacilities).toEqual(['Persona Equipo']);
    await http().delete(`/facilities/${created.body.id}`).set(s.auth).expect(204);
    const none = await http().get('/facilities').set(manager.auth).expect(200);
    expect(none.body).toEqual([]);
    const users = await http().get('/users').set(s.auth).expect(200);
    const row = (users.body as { id: string; facilityIds: string[] }[]).find(
      (u) => u.id === manager.id,
    );
    expect(row?.facilityIds).toEqual([]);
  }, 30_000);

  it('dirección pública: no se cambia en silencio y no tapa páginas de la web', async () => {
    const s = await setup('fac-slug');
    const other = await http()
      .post('/facilities')
      .set(s.auth)
      .send({ name: 'Local Sur', publicSlug: 'sur' })
      .expect(201);
    expect(other.body.publicSlug).toBe('sur');

    const taken = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'sur' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('slug_taken');
    expect(taken.body.details.suggestion).toBe('sur-2');

    const empty = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: '' });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('slug_required');

    const city = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'trasteros-en-madrid' });
    expect(city.status).toBe(409);
    expect(city.body.details.suggestion).toBe('madrid');

    // Guardar la que ya tiene no choca consigo misma.
    await http()
      .patch(`/facilities/${other.body.id}`)
      .set(s.auth)
      .send({ publicSlug: 'sur' })
      .expect(200);

    const named = await http()
      .post('/facilities')
      .set(s.auth)
      .send({ name: 'Trasteros en Valencia' })
      .expect(201);
    expect(named.body.publicSlug).toBe('valencia');
  });

  it('nombres de local sin repetir', async () => {
    const s = await setup('fac-name');
    await http().post('/facilities').set(s.auth).send({ name: 'Centro' }).expect(201);
    const repeated = await http().post('/facilities').set(s.auth).send({ name: 'CENTRO' });
    expect(repeated.status).toBe(409);
    expect(repeated.body.code).toBe('facility_name_taken');

    const rename = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ name: 'centro' });
    expect(rename.status).toBe(409);

    // Cambiar solo las mayúsculas del propio nombre sí se puede.
    const own = await db.facility.findUniqueOrThrow({ where: { id: s.facilityId } });
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ name: own.name.toUpperCase() })
      .expect(200);

    // Borrar libera el nombre.
    await http().delete(`/facilities/${s.facilityId}`).set(s.auth).expect(204);
    await http().post('/facilities').set(s.auth).send({ name: own.name }).expect(201);
  });

  it('los errores dicen qué campo falla; coordenadas y toque de queda completos', async () => {
    const s = await setup('fac-valid');
    const patch = (input: Record<string, unknown>) =>
      http().patch(`/facilities/${s.facilityId}`).set(s.auth).send(input);

    expect((await patch({ contactEmail: 'mal' })).body.message).toBe('Email no válido');
    expect((await patch({ timezone: 'Marte/Olympus' })).body.message).toBe(
      'Zona horaria no válida',
    );
    const video = await patch({ videoUrl: 'javascript:alert(1)' });
    expect(video.status).toBe(400);
    expect(video.body.message).toBe('Vídeo: El enlace tiene que empezar por https://');
    expect((await patch({ videoUrl: 'ftp://videos.example.com/a' })).status).toBe(400);

    const half = await patch({ latitude: 40.4 });
    expect(half.status).toBe(400);
    expect(half.body.code).toBe('coordinates_incomplete');
    await patch({ latitude: 40.4, longitude: -3.7 }).then((r) => expect(r.status).toBe(200));
    const cleared = await patch({ latitude: null, longitude: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ latitude: null, longitude: null });

    const noHours = await patch({ accessCurfewEnabled: true });
    expect(noHours.status).toBe(400);
    expect(noHours.body.code).toBe('curfew_hours_required');
    const create = await http()
      .post('/facilities')
      .set(s.auth)
      .send({ name: 'Con queda', accessCurfewEnabled: true, accessCurfewStart: '02:00' });
    expect(create.body.code).toBe('curfew_hours_required');
    const same = await http().post('/facilities').set(s.auth).send({
      name: 'Con queda',
      accessCurfewEnabled: true,
      accessCurfewStart: '02:00',
      accessCurfewEnd: '02:00',
    });
    expect(same.body.code).toBe('invalid_curfew');
  });

  it('una zona horaria mala guardada no deja a nadie en la puerta', async () => {
    const s = await setup('fac-tz', 1);
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({
        accessCurfewEnabled: true,
        accessCurfewStart: '02:00',
        accessCurfewEnd: '03:00',
      })
      .expect(200);
    await db.facility.update({ where: { id: s.facilityId }, data: { timezone: 'Bad/Zone' } });
    const customerId = await createCustomer(app, s.owner.accessToken);
    const device = await http()
      .post('/access/devices')
      .set(s.auth)
      .send({ facilityId: s.facilityId, type: 'gate', name: 'Puerta', hardwareId: 'fac-tz-1' })
      .expect(201);
    const credential = await http()
      .post('/access/credentials')
      .set(s.auth)
      .send({ allFacilities: true, customerId, method: 'pin' })
      .expect(201);
    const res = await http()
      .post('/access/verify')
      .set('X-Device-Key', device.body.revealedApiKey as string)
      .send({ method: 'pin', credential: credential.body.revealedSecret, deviceId: 'fac-tz-1' });
    expect(res.status).toBe(200);
  });

  it('las cifras cuadran con el Resumen y el dinero se oculta sin permiso', async () => {
    const s = await setup('fac-money', 3);
    const token = s.owner.accessToken;
    await ensureDefaultSeries(app, token);
    const real = await signed(s.auth, token, s.unitIds[0]!);

    // El inquilino de prueba no ocupa ni paga, para nadie.
    const test = await signed(s.auth, token, s.unitIds[1]!);
    await db.customer.update({ where: { id: test.customerId }, data: { isTest: true } });

    const issued = await http()
      .post('/invoices')
      .set(s.auth)
      .send({
        customerId: real.customerId,
        contractId: real.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${issued.body.id}/issue`).set(s.auth).send({}).expect(200);

    const summary = async () => {
      const res = await http().get('/facilities/summary').set(s.auth).expect(200);
      return (res.body as { facilityId: string }[]).find((f) => f.facilityId === s.facilityId);
    };
    expect(await summary()).toMatchObject({
      totalUnits: 3,
      occupiedUnits: 1,
      mrr: 50,
      avgPrice: 50,
      invoicedMonth: 121,
    });

    // Anular suma cero, igual que en el Resumen.
    await http()
      .post(`/invoices/${issued.body.id}/cancel`)
      .set(s.auth)
      .send({ reason: 'error' })
      .expect(200);
    expect(await summary()).toMatchObject({ invoicedMonth: 0 });

    const role = await http()
      .post('/settings/roles')
      .set(s.auth)
      .send({
        name: 'Solo locales',
        permissions: ['facilities:read', 'analytics:read'],
        baseRole: 'staff',
      })
      .expect(201);
    const staff = await invite(s.auth, s.owner.slug, 'staff');
    await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(s.auth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const auth = await staff.login();
    const hidden = await http().get('/facilities/summary').set(auth).expect(200);
    expect(hidden.body[0]).toMatchObject({
      occupiedUnits: 1,
      mrr: null,
      avgPrice: null,
      invoicedMonth: null,
    });
    await createFacilityWithUnits(app, token);
    const overview = await http().get('/dashboard/overview').set(auth).expect(200);
    expect(overview.body.byFacility[0]).toMatchObject({ mrr: null, overdue: null });
  }, 30_000);

  it('tipos: sin cambiar a vivienda con contratos, con tope y sin contar locales borrados', async () => {
    const s = await setup('fac-types', 2);
    await setTenantFeatureOverride(s.owner.slug, 'housing', true);
    await signed(s.auth, s.owner.accessToken, s.unitIds[0]!);
    const rented = await http()
      .patch(`/unit-types/${s.unitTypeId}`)
      .set(s.auth)
      .send({ propertyKind: 'housing' });
    expect(rented.status).toBe(409);
    expect(rented.body.code).toBe('cannot_change_kind_while_rented');
    // Guardar sin cambiarlo no choca.
    await http()
      .patch(`/unit-types/${s.unitTypeId}`)
      .set(s.auth)
      .send({ propertyKind: 'storage', name: 'Mediano' })
      .expect(200);

    const huge = await http()
      .post('/unit-types')
      .set(s.auth)
      .send({ name: 'Enorme', defaultPriceMonthly: 9_999_999 });
    expect(huge.status).toBe(400);
    expect(huge.body.message).toBe('Precio: Máximo 999.999 €');

    const other = await createFacilityWithUnits(app, s.owner.accessToken, { unitsCount: 2 });
    await http().delete(`/facilities/${other.facilityId}`).set(s.auth).expect(204);
    const list = await http().get('/unit-types').set(s.auth).expect(200);
    const row = (list.body as { id: string; unitsCount: number }[]).find(
      (t) => t.id === other.unitTypeId,
    );
    expect(row?.unitsCount).toBe(0);
  });

  it('plantas: sin nombres repetidos, plano que se quita y locales borrados fuera', async () => {
    const s = await setup('fac-floors', 1);
    const files = app.get(FilesService);
    const floor = await http()
      .post(`/facilities/${s.facilityId}/floors`)
      .set(s.auth)
      .send({ name: 'Sótano', floorNumber: -1 })
      .expect(201);
    const repeated = await http()
      .post(`/facilities/${s.facilityId}/floors`)
      .set(s.auth)
      .send({ name: 'sótano', floorNumber: -2 });
    expect(repeated.status).toBe(409);
    expect(repeated.body.code).toBe('floor_name_taken');
    const rename = await http().patch(`/floors/${s.floorId}`).set(s.auth).send({ name: 'SÓTANO' });
    expect(rename.status).toBe(409);

    const upload = async () => {
      const presign = await http()
        .post(`/floors/${floor.body.id}/plan-upload-url`)
        .set(s.auth)
        .send({ mimeType: 'image/png', sizeBytes: 100 })
        .expect(200);
      return presign.body as { uploadUrl: string; publicUrl: string };
    };
    const setPlan = (planImageUrl: string) =>
      http()
        .patch(`/floors/${floor.body.id}/plan`)
        .set(s.auth)
        .send({ planImageUrl, planWidthPx: 100, planHeightPx: 100 });

    // Sin subir nada no se guarda un plano roto.
    const first = await upload();
    const missing = await setPlan(first.publicUrl);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('file_not_uploaded');

    await fetch(first.uploadUrl, { method: 'PUT', body: PNG });
    await setPlan(first.publicUrl).then((r) => expect(r.status).toBe(200));
    const firstKey = files.keyFromPublicUrl('plans', first.publicUrl)!;

    // Cambiarlo borra el anterior.
    const second = await upload();
    await fetch(second.uploadUrl, { method: 'PUT', body: PNG });
    await setPlan(second.publicUrl).then((r) => expect(r.status).toBe(200));
    await expect(files.getObject({ bucket: 'plans', key: firstKey })).rejects.toBeTruthy();

    const removed = await http().delete(`/floors/${floor.body.id}/plan`).set(s.auth).expect(200);
    expect(removed.body.planImageUrl).toBeNull();
    const secondKey = files.keyFromPublicUrl('plans', second.publicUrl)!;
    await expect(files.getObject({ bucket: 'plans', key: secondKey })).rejects.toBeTruthy();

    const gone = await createFacilityWithUnits(app, s.owner.accessToken, { unitsCount: 1 });
    await db.facility.update({ where: { id: gone.facilityId }, data: { deletedAt: new Date() } });
    await http().patch(`/floors/${gone.floorId}`).set(s.auth).send({ name: 'Otra' }).expect(404);
    await http().delete(`/floors/${gone.floorId}/plan`).set(s.auth).expect(404);
  }, 30_000);

  it('fotos: tamaño real y sin registrar lo que no se subió', async () => {
    const s = await setup('fac-img', 1);
    const presign = async () => {
      const res = await http()
        .post(`/facilities/${s.facilityId}/images/upload-url`)
        .set(s.auth)
        .send({ mimeType: 'image/jpeg', sizeBytes: 100 })
        .expect(200);
      return res.body as { uploadUrl: string; key: string };
    };

    const ghost = await presign();
    const missing = await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [ghost.key] });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('file_not_uploaded');

    const big = await presign();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    JPEG.copy(bytes);
    await fetch(big.uploadUrl, { method: 'PUT', body: bytes });
    const tooBig = await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [big.key] });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.code).toBe('file_too_large');

    const one = await presign();
    await fetch(one.uploadUrl, { method: 'PUT', body: JPEG });
    const two = await presign();
    await fetch(two.uploadUrl, { method: 'PUT', body: JPEG });
    await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [one.key, two.key] })
      .expect(200);
    // Reordenar no vuelve a comprobar las que ya están.
    const spy = jest.spyOn(app.get(FilesService), 'assertObjectMimeType');
    await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [two.key, one.key] })
      .expect(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 30_000);

  it('presupuesto, documentos e importación', async () => {
    const s = await setup('fac-misc', 1);
    const auth = s.auth;

    // Presupuesto: un local desactivado no admite reservas.
    const lead = await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Ana', email: 'ana-quote@example.com', source: 'manual' })
      .expect(201);
    await http().patch(`/facilities/${s.facilityId}`).set(auth).send({ isActive: false });
    const quote = await http()
      .post(`/leads/${lead.body.id}/quote/preview`)
      .set(auth)
      .send({ facilityId: s.facilityId, unitTypeId: s.unitTypeId, months: 1 });
    expect(quote.status).toBe(409);
    expect(quote.body.code).toBe('facility_inactive');
    await http().patch(`/facilities/${s.facilityId}`).set(auth).send({ isActive: true });

    // Documentos: editar queda registrado y hay un segundo aviso al caducar.
    const presign = await http()
      .post(`/facilities/${s.facilityId}/documents/upload-url`)
      .set(auth)
      .send({ mimeType: 'application/pdf', sizeBytes: 100 })
      .expect(200);
    const doc = await http()
      .post(`/facilities/${s.facilityId}/documents`)
      .set(auth)
      .send({
        key: presign.body.key,
        kind: 'insurance',
        name: 'Póliza',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        expiresOn: isoDay(10),
      })
      .expect(201);
    await http()
      .patch(`/facilities/${s.facilityId}/documents/${doc.body.id}`)
      .set(auth)
      .send({ name: 'Póliza 2027' })
      .expect(200);
    expect(
      await db.auditLog.count({
        where: { tenantId: s.tenantId, action: 'facility.document_updated' },
      }),
    ).toBe(1);

    const cron = app.get(FacilityDocumentsExpiryCron);
    const notices = () =>
      db.notification.findMany({
        where: { tenantId: s.tenantId, type: 'facility.document_expiring' },
        orderBy: { createdAt: 'asc' },
      });
    await cron.run();
    expect(await notices()).toHaveLength(1);
    await cron.run();
    expect(await notices()).toHaveLength(1);
    await db.facilityDocument.update({
      where: { id: doc.body.id },
      data: { expiresOn: new Date(`${isoDay(-2)}T00:00:00Z`) },
    });
    await cron.run();
    const after = await notices();
    expect(after).toHaveLength(2);
    expect(after[1]?.title).toContain('Caducado');
    expect(after[1]?.body).toContain('pestaña Documentos');
    await cron.run();
    expect(await notices()).toHaveLength(2);

    // Importación: con dos locales iguales la fila no cae en uno al azar.
    const twin = await createFacilityWithUnits(app, s.owner.accessToken);
    const name = (await db.facility.findUniqueOrThrow({ where: { id: s.facilityId } })).name;
    await db.facility.update({ where: { id: twin.facilityId }, data: { name } });
    const type = await db.unitType.findUniqueOrThrow({ where: { id: s.unitTypeId } });
    const csv = `facility,unitType,code,widthM,depthM,heightM\n${name},${type.name},Z-1,2,2,2\n`;
    const preview = await http().post('/imports/units/preview').set(auth).send({ csv }).expect(201);
    expect(JSON.stringify(preview.body)).toContain('hay varios locales llamados');
  }, 30_000);
});
