import request from 'supertest';

import { PrismaService } from '../src/modules/database/prisma.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal: historial de accesos del inquilino (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino ve solo sus accesos', async () => {
    const owner = await registerVerifiedUser(app, 'paccesslogs');
    const email = `paccesslogs-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Sin sesión → 401.
    await request(app.getHttpServer()).get('/portal/me/access-logs').expect(401);

    // Aún sin accesos.
    const empty = await request(app.getHttpServer()).get('/portal/me/access-logs').set(pAuth);
    expect(empty.status).toBe(200);
    expect(empty.body).toHaveLength(0);

    // Insertamos un acceso del inquilino + uno de otro cliente (no debe verlo).
    const prisma = app.get(PrismaService);
    await prisma.withTenant(async (tx) => {
      await tx.accessLog.create({
        data: { tenantId: owner.tenantId, customerId, method: 'pin', result: 'allowed' },
      });
      await tx.accessLog.create({
        data: {
          tenantId: owner.tenantId,
          customerId: null,
          method: 'pin',
          result: 'denied_unknown',
        },
      });
    }, owner.tenantId);

    const after = await request(app.getHttpServer()).get('/portal/me/access-logs').set(pAuth);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].result).toBe('allowed');
    expect(after.body[0].method).toBe('pin');
    // El DTO slim NO expone datos internos.
    expect(after.body[0].attemptedValue).toBeUndefined();
    expect(after.body[0].ipAddress).toBeUndefined();
  });
});
