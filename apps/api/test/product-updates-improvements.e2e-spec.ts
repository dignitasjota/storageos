import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ProductUpdatesDigestService } from '../src/modules/product-updates/product-updates-digest.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-updates-improvements@storageos.local';

/**
 * Mejoras de «Novedades»: filtros, «¿Te ha sido útil?», prueba gratis desde
 * una novedad, novedades dirigidas y resumen mensual por correo. Todo va
 * dirigido a un plan propio de la prueba para no mezclarse con otras suites.
 */
describe('Novedades: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let adminAuth: { Authorization: string };
  let owner: VerifiedUser;
  let ownerAuth: { Authorization: string };
  let staffAuth: { Authorization: string };
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const planSlug = `e2e-pu-${stamp}`;
  const otherPlanSlug = `e2e-pu-other-${stamp}`;
  const createdUpdates: string[] = [];
  const createdAddons: string[] = [];
  const http = () => request(app.getHttpServer());

  async function publish(input: Record<string, unknown>): Promise<string> {
    const res = await http()
      .post('/admin/product-updates')
      .set(adminAuth)
      .send({ published: true, targetPlans: [planSlug], ...input });
    expect(res.status).toBe(201);
    createdUpdates.push(res.body.id as string);
    return res.body.id as string;
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin novedades',
        role: 'superadmin',
      },
    });
    for (const slug of [planSlug, otherPlanSlug]) {
      await admin.subscriptionPlan.create({
        data: {
          name: `Plan ${slug}`,
          slug,
          priceMonthly: 10,
          priceYearly: 100,
          tenantFeatures: [],
          isPublic: false,
        },
      });
    }
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminAuth = { Authorization: `Bearer ${login.body.accessToken as string}` };

    owner = await registerVerifiedUser(app, 'puimpr');
    ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    staffAuth = await scopedUser(app, owner, { role: 'staff', facilityIds: [], tag: 'pustaff' });
    // Un plan sin funciones: las de las novedades no están incluidas.
    await setTenantPlan(owner.slug, planSlug);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await admin.productUpdate.deleteMany({ where: { id: { in: createdUpdates } } });
    await cleanupTestTenants();
    await admin.subscriptionAddon.deleteMany({ where: { id: { in: createdAddons } } });
    await admin.subscriptionPlan.deleteMany({ where: { slug: { in: [planSlug, otherPlanSlug] } } });
    await admin.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await admin.$disconnect();
  });

  it('filtra por tipo, busca en título y texto y oculta lo que no está en el plan', async () => {
    const word = `zqx${stamp}`;
    await publish({ title: `Mejora ${word}`, body: 'Texto normal', category: 'improvement' });
    await publish({ title: 'Corrección', body: `Arreglado ${word}`, category: 'fix' });
    await publish({
      title: `Cámaras ${word}`,
      body: 'Nueva función de pago',
      category: 'new',
      feature: 'cameras',
    });

    const all = await http().get(`/product-updates/page?search=${word}`).set(ownerAuth).expect(200);
    expect(all.body.items).toHaveLength(3);

    const fixes = await http()
      .get(`/product-updates/page?search=${word}&category=fix`)
      .set(ownerAuth)
      .expect(200);
    expect(fixes.body.items.map((u: { title: string }) => u.title)).toEqual(['Corrección']);

    // «Solo lo de mi plan»: fuera la de cámaras (su plan no la incluye).
    const mine = await http()
      .get(`/product-updates/page?search=${word.toUpperCase()}&onlyMyPlan=1`)
      .set(ownerAuth)
      .expect(200);
    expect(mine.body.items).toHaveLength(2);
    expect(mine.body.items.some((u: { feature: string | null }) => u.feature === 'cameras')).toBe(
      false,
    );

    await http().get('/product-updates/page?category=otra').set(ownerAuth).expect(400);
  });

  it('«¿Te ha sido útil?»: se guarda, se cambia, se quita y el admin ve el recuento', async () => {
    const id = await publish({ title: `Útil ${stamp}`, body: 'Cuéntanos qué te parece' });

    await http()
      .put(`/product-updates/${id}/reaction`)
      .set(ownerAuth)
      .send({ value: 'up' })
      .expect(200);
    await http()
      .put(`/product-updates/${id}/reaction`)
      .set(staffAuth)
      .send({ value: 'down' })
      .expect(200);
    const page = await http().get(`/product-updates/page?search=${stamp}`).set(ownerAuth);
    const mine = page.body.items.find((u: { id: string }) => u.id === id);
    expect(mine.myReaction).toBe('up');

    const counts = async () => {
      const list = await http().get('/admin/product-updates').set(adminAuth).expect(200);
      const row = list.body.find((u: { id: string }) => u.id === id);
      return { up: row.helpfulUp as number, down: row.helpfulDown as number };
    };
    expect(await counts()).toEqual({ up: 1, down: 1 });

    // Cambiar de opinión no suma otra reacción.
    await http()
      .put(`/product-updates/${id}/reaction`)
      .set(ownerAuth)
      .send({ value: 'down' })
      .expect(200);
    expect(await counts()).toEqual({ up: 0, down: 2 });

    const removed = await http()
      .put(`/product-updates/${id}/reaction`)
      .set(ownerAuth)
      .send({ value: null })
      .expect(200);
    expect(removed.body).toEqual({ value: null });
    expect(await counts()).toEqual({ up: 0, down: 1 });

    await http()
      .put(`/product-updates/${id}/reaction`)
      .set(ownerAuth)
      .send({ value: 'meh' })
      .expect(400);
    // Una novedad dirigida a otro plan no se puede valorar.
    const other = await publish({
      title: 'De otro plan',
      body: 'No la ves',
      targetPlans: [otherPlanSlug],
    });
    await http()
      .put(`/product-updates/${other}/reaction`)
      .set(ownerAuth)
      .send({ value: 'up' })
      .expect(404);
  });

  it('prueba gratis desde una novedad: una sola vez y solo quien gestiona la suscripción', async () => {
    const addon = await admin.subscriptionAddon.create({
      data: {
        slug: `e2e-pu-addon-${stamp}`,
        name: 'Cámaras de prueba',
        priceMonthly: 0.5,
        feature: 'cameras',
      },
    });
    createdAddons.push(addon.id);
    const noFeature = await admin.subscriptionAddon.create({
      data: { slug: `e2e-pu-nofeature-${stamp}`, name: 'Sin función', priceMonthly: 1 },
    });
    createdAddons.push(noFeature.id);
    const id = await publish({
      title: `Prueba cámaras ${stamp}`,
      body: 'Pruébalas gratis',
      feature: 'cameras',
    });

    const offerOf = async (auth: { Authorization: string }) => {
      const page = await http().get(`/product-updates/page?search=${stamp}`).set(auth);
      return page.body.items.find((u: { id: string }) => u.id === id).trialOffer as {
        addonId: string;
        days: number;
      } | null;
    };
    expect(await offerOf(ownerAuth)).toMatchObject({ addonId: addon.id, days: 14 });

    // Sin permiso de suscripción (staff) no se puede activar.
    await http().post(`/settings/saas-billing/addons/${addon.id}/trial`).set(staffAuth).expect(403);
    await http()
      .post(`/settings/saas-billing/addons/${noFeature.id}/trial`)
      .set(ownerAuth)
      .expect(400);

    const started = await http()
      .post(`/settings/saas-billing/addons/${addon.id}/trial`)
      .set(ownerAuth)
      .expect(200);
    expect(started.body.feature).toBe('cameras');
    const days = (new Date(started.body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(14);

    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const override = await admin.tenantFeatureOverride.findUnique({
      where: { tenantId_feature: { tenantId: tenant.id, feature: 'cameras' } },
    });
    expect(override).toMatchObject({ enabled: true, source: 'trial', trialAddonId: addon.id });
    expect(
      await admin.tenantAddonTrial.count({ where: { tenantId: tenant.id, addonId: addon.id } }),
    ).toBe(1);
    expect(
      await admin.auditLog.count({
        where: { tenantId: tenant.id, action: 'saas_billing.addon_trial_started' },
      }),
    ).toBe(1);
    expect(
      await admin.superAdminNotification.count({
        where: { type: 'saas_addon.self_trial_started', link: `/admin/tenants/${tenant.id}` },
      }),
    ).toBe(1);

    // Ya la tiene: la novedad deja de ofrecerla.
    const after = await http().get(`/product-updates/page?search=${stamp}`).set(ownerAuth);
    const row = after.body.items.find((u: { id: string }) => u.id === id);
    expect(row.featureIncluded).toBe(true);
    expect(row.trialOffer).toBeNull();

    const again = await http()
      .post(`/settings/saas-billing/addons/${addon.id}/trial`)
      .set(ownerAuth)
      .expect(409);
    expect(again.body.code).toBe('addon_trial_used');

    // Aunque la prueba haya terminado, no se puede repetir.
    await admin.tenantFeatureOverride.deleteMany({
      where: { tenantId: tenant.id, feature: 'cameras' },
    });
    await http().post(`/settings/saas-billing/addons/${addon.id}/trial`).set(ownerAuth).expect(409);
    expect(await offerOf(ownerAuth)).toBeNull();
    // Otro extra que da la misma función tampoco se puede probar.
    const twin = await admin.subscriptionAddon.create({
      data: {
        slug: `e2e-pu-twin-${stamp}`,
        name: 'Cámaras bis',
        priceMonthly: 0.4,
        feature: 'cameras',
      },
    });
    createdAddons.push(twin.id);
    expect(await offerOf(ownerAuth)).toBeNull();
    await http().post(`/settings/saas-billing/addons/${twin.id}/trial`).set(ownerAuth).expect(409);
  });

  it('las novedades dirigidas solo las ven (y cuentan) los planes y roles elegidos', async () => {
    const before = {
      owner: (await http().get('/product-updates/unread-count').set(ownerAuth)).body.count,
      staff: (await http().get('/product-updates/unread-count').set(staffAuth)).body.count,
    };
    const forOwners = await publish({
      title: `Solo propietarios ${stamp}`,
      body: 'Para quien gestiona',
      targetRoles: ['owner'],
      highlighted: true,
    });
    await publish({
      title: `Otro plan ${stamp}`,
      body: 'No es para ti',
      targetPlans: [otherPlanSlug],
    });

    const ownerList = await http().get(`/product-updates/page?search=${stamp}`).set(ownerAuth);
    const staffList = await http().get(`/product-updates/page?search=${stamp}`).set(staffAuth);
    const titles = (r: request.Response) => r.body.items.map((u: { title: string }) => u.title);
    expect(titles(ownerList)).toContain(`Solo propietarios ${stamp}`);
    expect(titles(staffList)).not.toContain(`Solo propietarios ${stamp}`);
    expect(titles(ownerList)).not.toContain(`Otro plan ${stamp}`);

    expect((await http().get('/product-updates/unread-count').set(ownerAuth)).body.count).toBe(
      before.owner + 1,
    );
    expect((await http().get('/product-updates/unread-count').set(staffAuth)).body.count).toBe(
      before.staff,
    );
    const ownerHighlighted = await http().get('/product-updates/highlighted').set(ownerAuth);
    expect(ownerHighlighted.body.update?.id).toBe(forOwners);
    const staffHighlighted = await http().get('/product-updates/highlighted').set(staffAuth);
    expect(staffHighlighted.body.update?.id ?? null).not.toBe(forOwners);

    const list = await http().get('/admin/product-updates').set(adminAuth);
    const row = list.body.find((u: { id: string }) => u.id === forOwners);
    expect(row).toMatchObject({ targetPlans: [planSlug], targetRoles: ['owner'] });

    await http()
      .post('/admin/product-updates')
      .set(adminAuth)
      .send({ title: 'Rol raro', body: 'No vale', targetRoles: ['jefe'] })
      .expect(400);
  });

  it('resumen mensual: encola uno por usuario y mes, sin duplicar y respetando la baja', async () => {
    // Un mes antiguo en el que solo existen las novedades de esta prueba.
    await publish({
      title: `Resumen enero ${stamp}`,
      body: 'Lo que salió en **enero**.',
      publishAt: '2020-01-15T10:00:00.000Z',
    });
    await publish({
      title: `Solo gestores ${stamp}`,
      body: 'No le toca a nadie de esta prueba',
      targetRoles: ['manager'],
      publishAt: '2020-01-20T10:00:00.000Z',
    });
    // El personal se da de baja desde su perfil.
    await http()
      .patch('/me/email-notices')
      .set(staffAuth)
      .send({ product_updates_digest: false })
      .expect(200);

    const digest = app.get(ProductUpdatesDigestService);
    const now = new Date('2020-02-02T09:00:00.000Z');
    const first = await digest.sendMonthly(now);
    expect(first).toMatchObject({ month: '2020-01', updates: 2 });
    expect(first.sent).toBe(1);

    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const users = await admin.user.findMany({
      where: { tenantId: tenant.id },
      select: { role: true, productUpdatesDigestMonth: true, id: true },
    });
    expect(users.find((u) => u.role === 'owner')?.productUpdatesDigestMonth).toBe('2020-01');
    expect(users.find((u) => u.role === 'staff')?.productUpdatesDigestMonth).toBeNull();

    const mail = await waitForEmail(owner.email, { subjectIncludes: 'Novedades de TrasterOS' });
    expect(mail.Text).toContain(`Resumen enero ${stamp}`);
    expect(mail.Text).not.toContain(`Solo gestores ${stamp}`);
    expect(mail.Text).toContain('/baja-novedades/');

    // Otra vez el mismo mes (otra réplica, un reintento): no sale otro.
    const second = await digest.sendMonthly(now);
    expect(second.sent).toBe(0);

    // Baja desde el enlace del correo.
    const ownerId = users.find((u) => u.role === 'owner')!.id;
    const token = digest.unsubscribeToken(ownerId);
    const info = await http()
      .get(`/public/product-updates-digest/unsubscribe/${token}`)
      .expect(200);
    expect(info.body.unsubscribed).toBe(false);
    const done = await http()
      .post(`/public/product-updates-digest/unsubscribe/${token}`)
      .expect(200);
    expect(done.body.unsubscribed).toBe(true);
    const prefs = await http().get('/me/email-notices').set(ownerAuth).expect(200);
    expect(prefs.body.notices.product_updates_digest).toBe(false);
    await http().get('/public/product-updates-digest/unsubscribe/u.nope.firma').expect(404);

    // Dado de baja, tampoco lo recibe el mes siguiente.
    await publish({
      title: `Resumen febrero ${stamp}`,
      body: 'Febrero',
      publishAt: '2020-02-10T10:00:00.000Z',
    });
    const march = await digest.sendMonthly(new Date('2020-03-02T09:00:00.000Z'));
    expect(march).toMatchObject({ month: '2020-02', updates: 1, sent: 0 });

    // Un mes sin novedades no envía nada.
    const empty = await digest.sendMonthly(new Date('2019-07-02T09:00:00.000Z'));
    expect(empty).toEqual({ month: '2019-06', updates: 0, sent: 0 });
  }, 60_000);
});
