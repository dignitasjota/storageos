import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-limits-test@storageos.local';

/**
 * Enforcement de los límites del plan (maxUnits/maxFacilities/maxUsers)
 * ampliados por add-ons de capacidad.
 */
describe('Límites de plan + add-ons de capacidad (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let adminToken: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Limits Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await adminClient.subscriptionAddon.deleteMany({ where: { slug: { startsWith: 'e2e-cap-' } } });
    await adminClient.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('bloquea al superar el límite de locales y un add-on de capacidad lo amplía', async () => {
    const owner = await registerVerifiedUser(app, 'limit-fac');
    await setTenantPlan(owner.slug, 'free'); // free: maxFacilities = 1
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });
    const tenantId = tenant!.id;

    // Primer local: OK.
    const first = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local 1', country: 'ES' });
    expect(first.status).toBe(201);

    // Segundo local: supera el límite del plan free (1) → 403.
    const blocked = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local 2', country: 'ES' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('facilities_limit_reached');
    expect(blocked.body.details).toMatchObject({ limit: 1, current: 1 });

    // El super admin crea un add-on de capacidad (+2 locales) y lo asigna.
    const addon = await request(app.getHttpServer())
      .post('/admin/addons')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ slug: 'e2e-cap-fac', name: 'Locales extra', priceMonthly: 20, grantsFacilities: 2 });
    expect(addon.status).toBe(201);
    expect(addon.body.grantsFacilities).toBe(2);

    await request(app.getHttpServer())
      .post(`/admin/tenants/${tenantId}/addons`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ addonId: addon.body.id, quantity: 1 })
      .expect(201);

    // El límite efectivo pasa a 1 + 2 = 3 → el segundo local ya entra.
    const now = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local 2', country: 'ES' });
    expect(now.status).toBe(201);

    // El endpoint de límites lo refleja.
    const limits = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/limits`)
      .set({ Authorization: `Bearer ${adminToken}` });
    expect(limits.body.facilities).toMatchObject({ limit: 3, used: 2 });
  });

  it('bloquea al superar el límite de trasteros del plan', async () => {
    const owner = await registerVerifiedUser(app, 'limit-units');
    await setTenantPlan(owner.slug, 'free'); // free: maxUnits = 10
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const tenant = await adminClient.tenant.findUnique({ where: { slug: owner.slug } });

    // Comprobamos el camino feliz (crear dentro del límite) + que el endpoint de
    // límites devuelve el tope del plan free (maxUnits = 10).
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local U',
      unitsCount: 1,
    });
    expect(facilityId).toBeTruthy();

    const tenantId = tenant!.id;
    const limits = await request(app.getHttpServer())
      .get(`/admin/tenants/${tenantId}/limits`)
      .set({ Authorization: `Bearer ${adminToken}` });
    // free → maxUnits 10; ya hay 1 usada.
    expect(limits.body.units).toMatchObject({ limit: 10 });
    expect(limits.body.units.used).toBeGreaterThanOrEqual(1);

    // Crear un trastero adicional dentro del límite → OK.
    const extra = await request(app.getHttpServer())
      .post('/units')
      .set(auth)
      .send({ facilityId, unitTypeId, code: 'U-EXTRA', widthM: 2, depthM: 2, heightM: 2 });
    expect(extra.status).toBe(201);
  });

  it('no hay race: altas concurrentes respetan el límite (advisory lock)', async () => {
    const owner = await registerVerifiedUser(app, 'limit-race');
    await setTenantPlan(owner.slug, 'free'); // free: maxFacilities = 1
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // 6 altas de local a la vez. El límite es 1 → exactamente 1 debe entrar y el
    // resto 403: el advisory lock por (tenant, recurso) serializa el
    // check-then-create y cierra la ventana TOCTOU (sin el lock varias podrían
    // colarse porque cuentan 0 antes de que ninguna haya creado).
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app.getHttpServer())
          .post('/facilities')
          .set(auth)
          .send({ name: `Race ${i}`, country: 'ES' }),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 403);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    expect(rejected[0]!.body.code).toBe('facilities_limit_reached');
  });
});
