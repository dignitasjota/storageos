import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, withAdminDb } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const SUPER_EMAIL = 'tenant-web-indexing-super@storageos.local';
const SUPPORT_EMAIL = 'tenant-web-indexing-support@storageos.local';
const PASSWORD = 'AdminTest!23';
const DAY = 86_400_000;

interface Brand {
  noindex: boolean;
}
interface State {
  mode: string;
  decision: { indexable: boolean; inSitemap: boolean; reason: string };
}

/**
 * Indexación en Google por tenant (D3). Comprueba que el modo cambia el sitemap
 * y el `noindex` de la web, que los suspendidos y las bajas salen a su plazo, que
 * solo el super admin lo cambia y que una cuenta que no cambia de estado no se
 * mueve.
 */
describe('Indexación de la web por tenant (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let superToken: string;
  let supportToken: string;
  let owner: { slug: string; tenantId: string; accessToken: string };

  const http = () => request(app.getHttpServer());

  async function sitemapSlugs(): Promise<string[]> {
    const res = await http().get('/public/landing/sitemap');
    expect(res.status).toBe(200);
    return (res.body.entries as { tenantSlug: string }[]).map((e) => e.tenantSlug);
  }

  async function brandNoindex(slug: string): Promise<boolean> {
    const res = await http().get(`/public/landing/brand/${slug}`);
    expect(res.status).toBe(200);
    return (res.body as Brand).noindex;
  }

  async function setMode(mode: 'auto' | 'on' | 'off', token = superToken) {
    return http()
      .put(`/admin/web-indexing/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mode, reason: 'test' });
  }

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    const passwordHash = await argonHash(PASSWORD);
    await db.superAdmin.create({
      data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super Indexación', role: 'superadmin' },
    });
    await db.superAdmin.create({
      data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Soporte Indexación', role: 'support' },
    });
    app = await createTestApp();
    superToken = (
      await http().post('/admin/auth/login').send({ email: SUPER_EMAIL, password: PASSWORD })
    ).body.accessToken as string;
    supportToken = (
      await http().post('/admin/auth/login').send({ email: SUPPORT_EMAIL, password: PASSWORD })
    ).body.accessToken as string;

    const user = await registerVerifiedUser(app, 'web-indexing');
    await createFacilityWithUnits(app, user.accessToken, {
      facilityName: 'Local Indexación',
      unitsCount: 1,
      pricePerUnit: 50,
    });
    owner = { slug: user.slug, tenantId: user.tenantId, accessToken: user.accessToken };
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } } });
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('una cuenta activa y publicada es indexable y sale en el sitemap por defecto', async () => {
    const res = await http()
      .get(`/admin/web-indexing/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${superToken}`);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('auto');
    expect((res.body as { decision: State['decision'] }).decision).toMatchObject({
      indexable: true,
      inSitemap: true,
      reason: 'live',
    });
    expect(await sitemapSlugs()).toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(false);
  });

  it('«off» la saca del sitemap y la pone en noindex; «on» la vuelve a meter; «auto» restaura', async () => {
    expect((await setMode('off')).status).toBe(200);
    expect(await sitemapSlugs()).not.toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(true);

    expect((await setMode('on')).status).toBe(200);
    expect(await sitemapSlugs()).toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(false);

    expect((await setMode('auto')).status).toBe(200);
    expect(await sitemapSlugs()).toContain(owner.slug);
  });

  it('la cuenta de demostración no sale en automático, pero «on» la fuerza', async () => {
    await withAdminDb((d) =>
      d.tenant.update({ where: { id: owner.tenantId }, data: { tags: ['demo'] } }),
    );
    expect(await sitemapSlugs()).not.toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(true);

    await setMode('on');
    expect(await sitemapSlugs()).toContain(owner.slug);
    await setMode('auto');
    await withAdminDb((d) =>
      d.tenant.update({ where: { id: owner.tenantId }, data: { tags: [] } }),
    );
  });

  it('suspendido 15 días o más sale del sitemap y del índice; antes, la web sigue igual', async () => {
    await withAdminDb((d) =>
      d.tenant.update({
        where: { id: owner.tenantId },
        data: { status: 'suspended', canceledAt: new Date(Date.now() - 2 * DAY) },
      }),
    );
    expect(await sitemapSlugs()).not.toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(false);

    await withAdminDb((d) =>
      d.tenant.update({
        where: { id: owner.tenantId },
        data: { canceledAt: new Date(Date.now() - 20 * DAY) },
      }),
    );
    expect(await brandNoindex(owner.slug)).toBe(true);
    expect(await sitemapSlugs()).not.toContain(owner.slug);

    // Reactivado: vuelve a ser indexable sin tocar el modo.
    await withAdminDb((d) =>
      d.tenant.update({
        where: { id: owner.tenantId },
        data: { status: 'active', canceledAt: null },
      }),
    );
    expect(await sitemapSlugs()).toContain(owner.slug);
    expect(await brandNoindex(owner.slug)).toBe(false);
  });

  it('un negocio dado de baja sale del índice al instante', async () => {
    await withAdminDb((d) =>
      d.tenant.update({ where: { id: owner.tenantId }, data: { status: 'cancelled' } }),
    );
    expect(await brandNoindex(owner.slug)).toBe(true);
    expect(await sitemapSlugs()).not.toContain(owner.slug);
    await withAdminDb((d) =>
      d.tenant.update({ where: { id: owner.tenantId }, data: { status: 'active' } }),
    );
  });

  it('solo el super admin cambia el modo: el soporte recibe 403 y el valor no cambia', async () => {
    const res = await setMode('off', supportToken);
    expect(res.status).toBe(403);
    const state = await http()
      .get(`/admin/web-indexing/tenants/${owner.tenantId}`)
      .set('Authorization', `Bearer ${supportToken}`);
    expect(state.status).toBe(200);
    expect(state.body.mode).toBe('auto');
  });

  it('la lista previa la leen super admin y soporte, con el estado de hoy y el que tendría', async () => {
    const res = await http()
      .get('/admin/web-indexing/preview')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(res.status).toBe(200);
    const row = (
      res.body.rows as { tenantId: string; changes: boolean; today: unknown; withRule: unknown }[]
    ).find((r) => r.tenantId === owner.tenantId);
    expect(row).toBeDefined();
    // Una cuenta activa y publicada no cambia con la regla.
    expect(row?.changes).toBe(false);
    expect(row?.today).toEqual({ indexable: true, inSitemap: true });
    expect(row?.withRule).toMatchObject({ indexable: true, inSitemap: true });
  });

  it('sin sesión de admin no se lee ni se cambia la indexación', async () => {
    expect((await http().get('/admin/web-indexing/preview')).status).toBe(401);
    expect(
      (await http().put(`/admin/web-indexing/tenants/${owner.tenantId}`).send({ mode: 'off' }))
        .status,
    ).toBe(401);
  });
});
