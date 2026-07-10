import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * #7 de la 2ª auditoría: el token de staff revalida por request que el tenant
 * sigue vivo. Un tenant BORRADO (`deletedAt`) deja de operar aunque su access
 * token no haya expirado (antes seguía hasta 15 min).
 */
describe('TenantStatusGuard: token de staff de un tenant borrado → 403 (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('un tenant vivo opera con normalidad; al borrarlo (deletedAt) su token da 403 tenant_unavailable', async () => {
    const owner = await registerVerifiedUser(app, 'tenantstatus');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // Vivo: el token opera.
    const okBefore = await request(app.getHttpServer()).get('/auth/me').set(auth);
    expect(okBefore.status).toBe(200);

    // Borramos el tenant (soft delete): el guard aún no ha cacheado este tenant
    // en OTRO request nuevo → al próximo request revalida y bloquea.
    // (El /auth/me anterior cacheó alive=true; usamos un tenant distinto para
    //  evitar depender del TTL de la caché.)
    const victim = await registerVerifiedUser(app, 'tenantstatus-del');
    await adminClient.tenant.update({
      where: { id: victim.tenantId },
      data: { deletedAt: new Date() },
    });

    const blocked = await request(app.getHttpServer())
      .get('/auth/me')
      .set({ Authorization: `Bearer ${victim.accessToken}` });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('tenant_unavailable');
  });
});
