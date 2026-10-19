import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { TenantLifecycleEmailsService } from '../src/modules/admin/tenant-lifecycle-emails.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 24 * 3600 * 1000;

/**
 * Escalado del tenant suspendido: avisos al propietario los días 0, 7 y 14,
 * área de clientes y reserva desactivadas desde el primer día y web pública
 * fuera a partir del día 15.
 */
describe('Tenant suspendido: escalado (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('marca pública: área de clientes fuera desde el día 0 y web fuera desde el 15', async () => {
    const owner = await registerVerifiedUser(app, 'susesc');
    const brand = () => request(app.getHttpServer()).get(`/public/landing/brand/${owner.slug}`);

    let b = (await brand().expect(200)).body;
    expect(b.portalUnavailable).toBe(false);
    expect(b.webUnavailable).toBe(false);

    await admin.tenant.update({
      where: { slug: owner.slug },
      data: { status: 'suspended', canceledAt: new Date(Date.now() - 3 * DAY) },
    });
    b = (await brand().expect(200)).body;
    expect(b.portalUnavailable).toBe(true);
    expect(b.webUnavailable).toBe(false);

    await admin.tenant.update({
      where: { slug: owner.slug },
      data: { canceledAt: new Date(Date.now() - 16 * DAY) },
    });
    b = (await brand().expect(200)).body;
    expect(b.webUnavailable).toBe(true);

    await admin.tenant.update({ where: { slug: owner.slug }, data: { status: 'active' } });
    b = (await brand().expect(200)).body;
    expect(b.portalUnavailable).toBe(false);
    expect(b.webUnavailable).toBe(false);
  });

  it('avisa al propietario una vez por hito y episodio', async () => {
    const owner = await registerVerifiedUser(app, 'susescmail');
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    const svc = app.get(TenantLifecycleEmailsService);
    const since = new Date(Date.now() - 8 * DAY);
    await admin.tenant.update({
      where: { id: tenant.id },
      data: { status: 'suspended', canceledAt: since },
    });

    expect(await svc.runSuspensionNotices()).toBe(1);
    expect(await svc.runSuspensionNotices()).toBe(0);
    const rows = await admin.tenantLifecycleEmail.findMany({ where: { tenantId: tenant.id } });
    expect(rows.map((r) => r.type)).toEqual([`suspension_d7:${since.toISOString().slice(0, 10)}`]);

    // A los 14 días, el siguiente aviso.
    expect(await svc.runSuspensionNotices(new Date(since.getTime() + 14 * DAY + 3600_000))).toBe(1);

    // Pagado: ya no se avisa.
    await admin.tenant.update({ where: { id: tenant.id }, data: { status: 'active' } });
    expect(await svc.runSuspensionNotices(new Date(since.getTime() + 15 * DAY))).toBe(0);
  });
});
