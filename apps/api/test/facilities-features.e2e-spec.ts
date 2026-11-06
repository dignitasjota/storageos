import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Mejoras de Locales: el resumen de un local, la papelera, el horario completo,
 * cómo llegar, las direcciones antiguas, el texto de las fotos, duplicar, el
 * equipo, los avisos a sus inquilinos y el historial.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('Mejoras de Locales (e2e)', () => {
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

  const signed = async (
    auth: Record<string, string>,
    token: string,
    unitId: string,
    email?: string,
  ) => {
    const customerId = await createCustomer(app, token, email ? { email } : {});
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(-10), priceMonthly: 50 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { id: c.body.id as string, customerId };
  };

  async function portalSession(staffToken: string, customerId: string): Promise<string> {
    const link = await http()
      .post(`/customers/${customerId}/portal-link`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return consume.body.accessToken as string;
  }

  /** Invita a alguien y devuelve su token y su id. */
  async function invite(ownerAuth: Record<string, string>, tenantSlug: string, role: string) {
    const email = `fac-feat-${role}-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(ownerAuth).send({ email, role }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Persona Equipo', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const user = (users.body as { id: string; email: string }[]).find((x) => x.email === email)!;
    const res = await http().post('/auth/login').send({ tenantSlug, email, password: 'Passw0rd!' });
    return { id: user.id, auth: { Authorization: `Bearer ${res.body.accessToken}` } };
  }

  it('el resumen cuenta lo del local y solo lo suyo', async () => {
    const s = await setup('fac-over', 3);
    const token = s.owner.accessToken;
    const other = await createFacilityWithUnits(app, token, { unitsCount: 1 });
    await signed(s.auth, token, other.unitIds[0]!);

    await signed(s.auth, token, s.unitIds[0]!);
    await http()
      .post(`/units/${s.unitIds[1]}/change-status`)
      .set(s.auth)
      .send({ status: 'maintenance', reason: 'Reparación de la puerta' })
      .expect(200);
    await http()
      .post('/waitlist')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        unitTypeId: s.unitTypeId,
        contactName: 'Ana',
        contactEmail: 'ana@example.com',
      })
      .expect(201);
    await http()
      .post('/incidents')
      .set(s.auth)
      .send({ title: 'Gotera en el pasillo', severity: 'medium', facilityId: s.facilityId })
      .expect(201);
    await db.facilityDocument.create({
      data: {
        tenantId: s.tenantId,
        facilityId: s.facilityId,
        kind: 'insurance',
        name: 'Seguro del local',
        fileKey: `${s.tenantId}/x.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        expiresOn: new Date(`${isoDay(10)}T00:00:00Z`),
      },
    });
    const device = await http()
      .post('/access/devices')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        name: 'Puerta principal',
        type: 'gate',
        hardwareId: `over-${s.facilityId}`,
      })
      .expect(201);
    await db.accessDevice.update({
      where: { id: device.body.id },
      data: { isOnline: false, lastHeartbeatAt: new Date(Date.now() - DAY) },
    });

    const overview = await http()
      .get(`/facilities/${s.facilityId}/overview`)
      .set(s.auth)
      .expect(200);
    expect(overview.body).toMatchObject({
      mrr: 50,
      overdue: 0,
      moveIns: 1,
      moveOuts: 0,
      waitlist: 1,
      tenantsReachable: 1,
      openIncidents: 1,
    });
    expect(overview.body.byType).toEqual([
      expect.objectContaining({
        unitTypeId: s.unitTypeId,
        total: 3,
        occupied: 1,
        reserved: 0,
        available: 1,
        outOfService: 1,
        avgPrice: 50,
      }),
    ]);
    expect(overview.body.expiringDocuments).toEqual([
      expect.objectContaining({ name: 'Seguro del local', daysToExpiry: 10 }),
    ]);
    expect(overview.body.offlineDevices).toEqual([
      expect.objectContaining({ name: 'Puerta principal' }),
    ]);
    expect(overview.body.publicUrl).toContain(`/s/${s.owner.slug}/`);

    // Con dominio propio, su dirección allí; con web externa, `/<local>` no es
    // nuestro y el enlace lleva a la reserva del local.
    const domain = `${s.owner.slug}.example.test`;
    await db.tenant.update({
      where: { id: s.tenantId },
      data: { customDomain: domain, customDomainVerifiedAt: new Date() },
    });
    const own = await http().get(`/facilities/${s.facilityId}/overview`).set(s.auth).expect(200);
    expect(own.body.publicUrl).toMatch(new RegExp(`^https://${domain}/[^/]+$`));
    await db.tenant.update({
      where: { id: s.tenantId },
      data: { externalSiteUrl: 'https://example.com' },
    });
    const external = await http()
      .get(`/facilities/${s.facilityId}/overview`)
      .set(s.auth)
      .expect(200);
    expect(external.body.publicUrl).toMatch(new RegExp(`^https://${domain}/reservar/[^/]+$`));

    // La comparación entre locales lleva las mismas cifras.
    const summary = await http().get('/facilities/summary').set(s.auth).expect(200);
    const row = (summary.body as { facilityId: string }[]).find(
      (x) => x.facilityId === s.facilityId,
    );
    expect(row).toMatchObject({ overdue: 0, moveIns: 1, moveOuts: 0 });

    const stranger = await setup('fac-over-x', 0);
    await http().get(`/facilities/${s.facilityId}/overview`).set(stranger.auth).expect(404);
  });

  it('un local borrado se restaura con lo que tenía, y solo durante 30 días', async () => {
    const s = await setup('fac-trash', 1);
    const before = await http().get(`/facilities/${s.facilityId}`).set(s.auth).expect(200);
    const slug = before.body.publicSlug as string;
    const name = before.body.name as string;
    const device = await http()
      .post('/access/devices')
      .set(s.auth)
      .send({
        facilityId: s.facilityId,
        name: 'Puerta',
        type: 'gate',
        hardwareId: `trash-${s.facilityId}`,
      })
      .expect(201);
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
    // Lo que ya estaba apagado al borrar no se enciende al restaurar.
    const paused = await http()
      .post('/maintenance-plans')
      .set(s.auth)
      .send({
        title: 'Pausado',
        type: 'inspection',
        priority: 'low',
        freq: 'monthly',
        interval: 1,
        dayOfMonth: 1,
        startDate: isoDay(-40),
        facilityId: s.facilityId,
      })
      .expect(201);
    await db.maintenancePlan.update({
      where: { id: paused.body.id },
      data: { isActive: false },
    });

    await http().delete(`/facilities/${s.facilityId}`).set(s.auth).expect(204);
    const trash = await http().get('/facilities/deleted').set(s.auth).expect(200);
    expect(trash.body).toEqual([
      expect.objectContaining({ id: s.facilityId, name, daysLeft: 30, unitsCount: 1 }),
    ]);

    // Su nombre lo ha cogido otro local: primero hay que cambiárselo.
    const twin = await http()
      .post('/facilities')
      .set(s.auth)
      .send({ name, country: 'ES', timezone: 'Europe/Madrid', publicSlug: 'otra-direccion' })
      .expect(201);
    const clash = await http().post(`/facilities/${s.facilityId}/restore`).set(s.auth);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('facility_name_taken');
    await http()
      .patch(`/facilities/${twin.body.id}`)
      .set(s.auth)
      .send({ name: 'Local nuevo', publicSlug: slug })
      .expect(200);

    const restored = await http().post(`/facilities/${s.facilityId}/restore`).set(s.auth);
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toEqual({
      maintenancePlans: 1,
      recurringExpenses: 0,
      accessDevices: 1,
      cameraDevices: 0,
    });
    expect(restored.body.facility).toMatchObject({ isActive: true, name });
    // La dirección ya es de otro local: se queda con una libre.
    expect(restored.body.facility.publicSlug).toBe(`${slug}-2`);
    expect(await db.accessDevice.findUnique({ where: { id: device.body.id } })).toMatchObject({
      isActive: true,
    });
    expect(await db.maintenancePlan.findUnique({ where: { id: plan.body.id } })).toMatchObject({
      isActive: true,
    });
    expect(await db.maintenancePlan.findUnique({ where: { id: paused.body.id } })).toMatchObject({
      isActive: false,
    });
    const detail = await http().get(`/facilities/${s.facilityId}`).set(s.auth).expect(200);
    expect(detail.body.unitsTotal).toBe(1);
    await http().post(`/facilities/${s.facilityId}/restore`).set(s.auth).expect(404);

    // Pasado el plazo sale de la papelera.
    await http().delete(`/facilities/${s.facilityId}`).set(s.auth).expect(204);
    await db.facility.update({
      where: { id: s.facilityId },
      data: { deletedAt: new Date(Date.now() - 31 * DAY) },
    });
    const late = await http().post(`/facilities/${s.facilityId}/restore`).set(s.auth);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('facility_restore_expired');
    expect((await http().get('/facilities/deleted').set(s.auth)).body).toEqual([]);

    // Sin permiso para gestionar locales no se restaura nada.
    const staff = await invite(s.auth, s.owner.slug, 'staff');
    await http().get('/facilities/deleted').set(staff.auth).expect(403);
    await http().post(`/facilities/${s.facilityId}/restore`).set(staff.auth).expect(403);
  });

  it('horario partido, 24 horas y días especiales llegan a la web y al área de clientes', async () => {
    const s = await setup('fac-hours', 1);
    const token = s.owner.accessToken;
    const contract = await signed(s.auth, token, s.unitIds[0]!);

    const wrong = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({
        openingHours: { mon: { open: '09:00', close: '14:00', open2: '13:00', close2: '20:00' } },
      });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toContain('segundo turno');
    const half = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ openingHours: { mon: { open: '09:00', close: '14:00', open2: '16:00' } } });
    expect(half.status).toBe(400);

    const hours = {
      mon: { open: '09:00', close: '14:00', open2: '16:00', close2: '20:00' },
      sat: { open: '00:00', close: '00:00' },
    };
    const exceptions = [
      { date: isoDay(60), label: 'Lejos', hours: null },
      { date: isoDay(5), label: 'Festivo', hours: null },
      { date: isoDay(3), hours: { open: '10:00', close: '13:00' } },
    ];
    const saved = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ openingHours: hours, openingExceptions: exceptions })
      .expect(200);
    expect(saved.body.openingHours).toEqual(hours);
    expect(saved.body.openingExceptions.map((e: { date: string }) => e.date)).toEqual([
      isoDay(3),
      isoDay(5),
      isoDay(60),
    ]);

    const landing = await http().get(`/public/landing/${s.owner.slug}`).expect(200);
    expect(landing.body.facilities[0].openingHours).toEqual(hours);
    expect(landing.body.facilities[0].openingExceptions).toHaveLength(3);

    const session = await portalSession(token, contract.customerId);
    const facilities = await http()
      .get('/portal/me/facilities')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    // En el área de clientes solo lo que viene.
    expect(facilities.body[0].openingExceptions.map((e: { date: string }) => e.date)).toEqual([
      isoDay(3),
      isoDay(5),
    ]);
  });

  it('cómo llegar: el enlace da la ubicación y llega a la web, al área de clientes y al correo', async () => {
    const s = await setup('fac-map', 2);
    const token = s.owner.accessToken;
    const longLink =
      'https://www.google.com/maps/place/Sol/@40.41,-3.70,17z/data=!3m1!4b1!3d40.41689!4d-3.70346';

    const set = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ directions: 'Entrada por la calle de atrás', mapsUrl: longLink })
      .expect(200);
    expect(set.body).toMatchObject({
      directions: 'Entrada por la calle de atrás',
      mapsUrl: longLink,
      latitude: 40.41689,
      longitude: -3.70346,
    });

    // Un local con ubicación no la pierde por pegar otro enlace.
    const again = await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ mapsUrl: 'https://www.google.com/maps/@39.46,-0.37,15z' })
      .expect(200);
    expect(again.body.latitude).toBe(40.41689);
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ mapsUrl: 'javascript:alert(1)' })
      .expect(400);

    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ features: ['climate', 'cctv'] })
      .expect(200);
    const landing = await http().get(`/public/landing/${s.owner.slug}`).expect(200);
    expect(landing.body.facilities[0]).toMatchObject({
      directions: 'Entrada por la calle de atrás',
      mapsUrl: 'https://www.google.com/maps/@39.46,-0.37,15z',
      features: ['climate', 'cctv'],
    });

    const contract = await signed(s.auth, token, s.unitIds[0]!);
    const session = await portalSession(token, contract.customerId);
    const facilities = await http()
      .get('/portal/me/facilities')
      .set('Authorization', `Bearer ${session}`)
      .expect(200);
    expect(facilities.body[0]).toMatchObject({
      directions: 'Entrada por la calle de atrás',
      directionsUrl: 'https://www.google.com/maps/@39.46,-0.37,15z',
    });

    let body: string | null = null;
    for (let i = 0; i < 40 && !body; i++) {
      const row = await db.communication.findFirst({
        where: {
          tenantId: s.tenantId,
          customerId: contract.customerId,
          bodyText: { contains: 'Cómo llegar' },
        },
      });
      body = row?.bodyText ?? null;
      if (!body) await new Promise((r) => setTimeout(r, 250));
    }
    expect(body).toContain('Cómo llegar: Entrada por la calle de atrás');
  });

  it('la dirección antigua lleva a la nueva hasta que otro local se la queda', async () => {
    const s = await setup('fac-slug', 1);
    const token = s.owner.accessToken;
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'antigua' })
      .expect(200);
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'nueva' })
      .expect(200);

    const moved = await http().get(`/public/landing/${s.owner.slug}/antigua`);
    expect(moved.status).toBe(404);
    expect(moved.body).toMatchObject({ code: 'facility_moved', details: { slug: 'nueva' } });
    await http().get(`/public/landing/${s.owner.slug}/nueva`).expect(200);

    // Volver a la anterior: la nueva pasa a ser la antigua, sin bucles.
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'antigua' })
      .expect(200);
    await http().get(`/public/landing/${s.owner.slug}/antigua`).expect(200);
    const back = await http().get(`/public/landing/${s.owner.slug}/nueva`);
    expect(back.body).toMatchObject({ code: 'facility_moved', details: { slug: 'antigua' } });

    // Otro local toma la dirección liberada: deja de redirigir.
    const other = await createFacilityWithUnits(app, token, { unitsCount: 1 });
    await http()
      .patch(`/facilities/${other.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'nueva' })
      .expect(200);
    const taken = await http().get(`/public/landing/${s.owner.slug}/nueva`).expect(200);
    expect(taken.body.facility.id).toBe(other.facilityId);

    // Una landing con dirección corta también se la queda, si llega a guardarse.
    await http()
      .patch(`/facilities/${other.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'tercera' })
      .expect(200);
    expect((await http().get(`/public/landing/${s.owner.slug}/nueva`)).body.code).toBe(
      'facility_moved',
    );
    await setTenantFeatureOverride(s.owner.slug, 'web_premium', true);
    const landing = await http()
      .post('/promo-landings')
      .set(s.auth)
      .send({ name: 'Nueva', slug: 'nueva', headline: 'Oferta' })
      .expect(201);
    await http()
      .post('/promo-landings')
      .set(s.auth)
      .send({ name: 'Repetida', slug: 'nueva', headline: 'Oferta', shortPath: true })
      .expect(409);
    expect((await http().get(`/public/landing/${s.owner.slug}/nueva`)).body.code).toBe(
      'facility_moved',
    );
    await http()
      .patch(`/promo-landings/${landing.body.id}`)
      .set(s.auth)
      .send({ shortPath: true })
      .expect(200);
    expect((await http().get(`/public/landing/${s.owner.slug}/nueva`)).body.code).toBe(
      'facility_not_found',
    );
    await http()
      .patch(`/facilities/${other.facilityId}`)
      .set(s.auth)
      .send({ publicSlug: 'cuarta' })
      .expect(200);
    await http()
      .post('/promo-landings')
      .set(s.auth)
      .send({ name: 'Tercera', slug: 'tercera', headline: 'Oferta', shortPath: true })
      .expect(201);
    expect((await http().get(`/public/landing/${s.owner.slug}/tercera`)).body.code).toBe(
      'facility_not_found',
    );

    // Y una dirección que nunca existió sigue siendo un 404 normal.
    const none = await http().get(`/public/landing/${s.owner.slug}/inventada`);
    expect(none.body.code).toBe('facility_not_found');
  });

  it('las fotos guardan su texto alternativo, también al ordenarlas', async () => {
    const s = await setup('fac-alt', 1);
    const upload = async () => {
      const presign = await http()
        .post(`/facilities/${s.facilityId}/images/upload-url`)
        .set(s.auth)
        .send({ mimeType: 'image/jpeg', sizeBytes: JPEG.length })
        .expect(200);
      await fetch(presign.body.uploadUrl as string, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: JPEG,
      });
      return presign.body.key as string;
    };
    const [a, b] = [await upload(), await upload()];
    const saved = await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [a, b], alts: { [a]: 'Entrada del local', [b]: '  ' } })
      .expect(200);
    expect(saved.body.images.map((i: { alt: string | null }) => i.alt)).toEqual([
      'Entrada del local',
      null,
    ]);

    // Reordenar sin mandar textos los conserva; quitar una foto se lleva el suyo.
    const reordered = await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [b, a] })
      .expect(200);
    expect(reordered.body.images.map((i: { alt: string | null }) => i.alt)).toEqual([
      null,
      'Entrada del local',
    ]);
    const landing = await http().get(`/public/landing/${s.owner.slug}`).expect(200);
    expect(landing.body.facilities[0].imageAlts).toEqual([null, 'Entrada del local']);
    await http()
      .put(`/facilities/${s.facilityId}/images`)
      .set(s.auth)
      .send({ images: [b] })
      .expect(200);
    expect(
      (await db.facility.findUniqueOrThrow({ where: { id: s.facilityId } })).imageAlts,
    ).toEqual({});
  });

  it('duplicar copia la forma de trabajar y no lo que es de cada local', async () => {
    const s = await setup('fac-dup', 1);
    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({
        address: 'Calle Mayor 1',
        contactPhone: '600000000',
        features: ['climate'],
        openingHours: { mon: { open: '09:00', close: '14:00' } },
        openingExceptions: [{ date: isoDay(3), label: 'Festivo', hours: null }],
        accessCurfewEnabled: true,
        accessCurfewStart: '23:00',
        accessCurfewEnd: '06:00',
      })
      .expect(200);
    await http()
      .post(`/facilities/${s.facilityId}/floors`)
      .set(s.auth)
      .send({ name: 'Sótano', floorNumber: -1 })
      .expect(201);
    const source = await http().get(`/facilities/${s.facilityId}`).set(s.auth).expect(200);

    const copy = await http()
      .post(`/facilities/${s.facilityId}/duplicate`)
      .set(s.auth)
      .send({ name: 'Local copiado' })
      .expect(201);
    expect(copy.body).toMatchObject({
      name: 'Local copiado',
      publicSlug: 'local-copiado',
      address: null,
      contactPhone: '600000000',
      features: ['climate'],
      accessCurfewEnabled: true,
      unitsTotal: 0,
      images: [],
    });
    expect(copy.body.openingHours).toEqual(source.body.openingHours);
    expect(copy.body.openingExceptions).toEqual(source.body.openingExceptions);
    const floors = await http().get(`/facilities/${copy.body.id}/floors`).set(s.auth).expect(200);
    const names = (rows: { name: string }[]) => rows.map((f) => f.name).sort();
    const sourceFloors = await http().get(`/facilities/${s.facilityId}/floors`).set(s.auth);
    expect(names(floors.body)).toEqual(names(sourceFloors.body));

    const clash = await http()
      .post(`/facilities/${s.facilityId}/duplicate`)
      .set(s.auth)
      .send({ name: 'Local copiado' });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('facility_name_taken');
  });

  it('equipo, aviso a sus inquilinos e historial', async () => {
    const s = await setup('fac-team', 1);
    const token = s.owner.accessToken;
    const other = await createFacilityWithUnits(app, token, { unitsCount: 1 });
    const here = await signed(s.auth, token, s.unitIds[0]!, `aqui-${Date.now()}@e2e.local`);
    const away = await signed(s.auth, token, other.unitIds[0]!, `otro-${Date.now()}@e2e.local`);

    const staff = await invite(s.auth, s.owner.slug, 'staff');
    await http()
      .patch(`/settings/users/${staff.id}/facilities`)
      .set(s.auth)
      .send({ facilityIds: [s.facilityId] })
      .expect(204);
    const team = await http().get(`/facilities/${s.facilityId}/team`).set(s.auth).expect(200);
    expect(team.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'owner', access: 'all' }),
        expect.objectContaining({ id: staff.id, access: 'assigned' }),
      ]),
    );
    const otherTeam = await http().get(`/facilities/${other.facilityId}/team`).set(s.auth);
    expect(otherTeam.body.map((u: { id: string }) => u.id)).not.toContain(staff.id);

    // Dado de baja de las ofertas: un aviso de servicio le llega igual.
    await db.customer.update({
      where: { id: here.customerId },
      data: { marketingOptOutAt: new Date() },
    });
    const sent = await http()
      .post(`/customers/by-facility/${s.facilityId}/message`)
      .set(s.auth)
      .send({ subject: 'Corte de agua', bodyText: 'El martes no habrá agua en el local.' })
      .expect(200);
    expect(sent.body).toEqual({ sent: 1 });
    const rows = await db.communication.findMany({
      where: { tenantId: s.tenantId, subject: 'Corte de agua' },
    });
    expect(rows.map((r) => r.customerId)).toEqual([here.customerId]);
    expect(rows.map((r) => r.customerId)).not.toContain(away.customerId);
    await http()
      .post(`/customers/by-facility/${s.facilityId}/message`)
      .set(s.auth)
      .send({ subject: 'x', bodyText: 'y' })
      .expect(400);
    await http()
      .post(`/customers/by-facility/${other.facilityId}/message`)
      .set(staff.auth)
      .send({ subject: 'Corte de agua', bodyText: 'Fuera de su alcance' })
      .expect(403);

    await http()
      .patch(`/facilities/${s.facilityId}`)
      .set(s.auth)
      .send({ city: 'Sevilla' })
      .expect(200);
    const floor = await http()
      .post(`/facilities/${s.facilityId}/floors`)
      .set(s.auth)
      .send({ name: 'Altillo', floorNumber: 2 })
      .expect(201);
    await http().delete(`/floors/${floor.body.id}`).set(s.auth).expect(204);
    const history = await http().get(`/facilities/${s.facilityId}/history`).set(s.auth).expect(200);
    const actions = (history.body.items as { action: string }[]).map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['facility.updated', 'facility.tenants_messaged', 'facility.created']),
    );
    // También lo de una planta que ya no existe.
    expect(actions).toEqual(expect.arrayContaining(['floor.created', 'floor.deleted']));
    expect(history.body.items[0]).toMatchObject({ userName: expect.any(String) });
    await http().get(`/facilities/${s.facilityId}/history?cursor=nope`).set(s.auth).expect(400);
    await http().get(`/facilities/${s.facilityId}/history`).set(staff.auth).expect(403);
  });
});
