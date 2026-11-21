import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Mejoras de Configuración → Dominio propio: el destino del registro DNS desde
 * el principio y la web con y sin `www.` (comprobación por separado,
 * resolución de las dos formas y una sola cuenta por dominio).
 */
describe('Dominio propio con y sin www (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;

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

  async function proOwner(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    await setTenantPlan(owner.slug, 'pro');
    return { ...owner, auth: { Authorization: `Bearer ${owner.accessToken}` } };
  }

  it('da el destino del registro DNS sin haber guardado nada', async () => {
    const owner = await proOwner('domtarget');
    const res = await request(app.getHttpServer())
      .get('/settings/tenant/domain/target')
      .set(owner.auth);
    expect(res.status).toBe(200);
    expect(typeof res.body.host).toBe('string');
    expect(res.body.host.length).toBeGreaterThan(0);
    expect(res.body.addresses).toEqual(['203.0.113.10']);

    await request(app.getHttpServer()).get('/settings/tenant/domain/target').expect(401);
  });

  it('comprueba el dominio y su forma con www por separado', async () => {
    const owner = await proOwner('domcheck');
    const domain = `ready-nowww-${owner.slug}.com`;
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(owner.auth)
      .send({ customDomain: domain })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/settings/tenant/domain/check')
      .set(owner.auth);
    expect(res.status).toBe(200);
    expect(res.body.pointsToPlatform).toBe(true);
    expect(res.body.hosts).toEqual([
      { host: domain, purpose: 'primary', pointsToPlatform: true, found: ['203.0.113.10'] },
      { host: `www.${domain}`, purpose: 'alternate', pointsToPlatform: false, found: [] },
    ]);

    // Un subdominio no tiene forma con www.
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(owner.auth)
      .send({ customDomain: `trasteros.${owner.slug}.com` })
      .expect(200);
    const sub = await request(app.getHttpServer())
      .post('/settings/tenant/domain/check')
      .set(owner.auth);
    expect(sub.status).toBe(200);
    expect(sub.body.pointsToPlatform).toBe(false);
    expect(sub.body.hosts).toHaveLength(1);
  });

  it('la web responde con y sin www y dice cuál es la principal', async () => {
    const owner = await proOwner('domwww');
    const domain = `${owner.slug}-www.com`;
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(owner.auth)
      .send({ customDomain: domain })
      .expect(200);
    await db.tenant.update({
      where: { slug: owner.slug },
      data: { customDomainVerifiedAt: new Date() },
    });

    for (const host of [domain, `www.${domain}`, `WWW.${domain.toUpperCase()}`]) {
      const res = await request(app.getHttpServer())
        .get('/public/landing/resolve-domain')
        .query({ host });
      expect(res.status).toBe(200);
      expect(res.body.tenantSlug).toBe(owner.slug);
      expect(res.body.canonicalHost).toBe(domain);
    }

    await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: `otro.${domain}` })
      .expect(404);
  });

  it('con www guardado, el dominio sin www también es suyo', async () => {
    const owner = await proOwner('domwwwfirst');
    const bare = `${owner.slug}-first.com`;
    await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(owner.auth)
      .send({ customDomain: `www.${bare}` })
      .expect(200);
    await db.tenant.update({
      where: { slug: owner.slug },
      data: { customDomainVerifiedAt: new Date() },
    });
    const res = await request(app.getHttpServer())
      .get('/public/landing/resolve-domain')
      .query({ host: bare });
    expect(res.status).toBe(200);
    expect(res.body.canonicalHost).toBe(`www.${bare}`);

    // Otra cuenta no puede quedarse con la otra forma del mismo dominio.
    const other = await proOwner('domwwwother');
    const taken = await request(app.getHttpServer())
      .patch('/settings/tenant/branding')
      .set(other.auth)
      .send({ customDomain: bare });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('domain_taken');
  });
});
