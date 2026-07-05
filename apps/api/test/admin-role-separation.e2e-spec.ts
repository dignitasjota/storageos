import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const SUPER_EMAIL = 'admin-rolesep-super@storageos.local';
const SUPPORT_EMAIL = 'admin-rolesep-support@storageos.local';

/** Login del super admin → access token. */
async function login(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email, password: 'AdminTest!23' });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login fallo: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.accessToken as string;
}

describe('Admin: separación de roles superadmin/support + revocación (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;
  let superToken: string;
  let supportToken: string;
  let supportId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await adminClient.superAdmin.deleteMany({
      where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } },
    });
    const passwordHash = await argonHash('AdminTest!23');
    await adminClient.superAdmin.create({
      data: { email: SUPER_EMAIL, passwordHash, fullName: 'Super', role: 'superadmin' },
    });
    const support = await adminClient.superAdmin.create({
      data: { email: SUPPORT_EMAIL, passwordHash, fullName: 'Support', role: 'support' },
    });
    supportId = support.id;
    app = await createTestApp();
    superToken = await login(app, SUPER_EMAIL);
    supportToken = await login(app, SUPPORT_EMAIL);
  });

  afterAll(async () => {
    await app.close();
    await adminClient.superAdmin.deleteMany({
      where: { email: { in: [SUPER_EMAIL, SUPPORT_EMAIL] } },
    });
    await adminClient.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('el rol support NO puede ejecutar acciones destructivas/de dinero (403), el superadmin sí las ve', async () => {
    const owner = await registerVerifiedUser(app, 'rolesep');

    // support → anonymize = 403 insufficient_super_admin_role.
    const anon = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/anonymize`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ reason: 'intento no autorizado' });
    expect(anon.status).toBe(403);
    expect(anon.body.code).toBe('insufficient_super_admin_role');

    // support → suspend = 403.
    const susp = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ reason: 'x' });
    expect(susp.status).toBe(403);

    // support → impersonate = 403.
    const imp = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/impersonate`)
      .set('Authorization', `Bearer ${supportToken}`)
      .send({ reason: 'x' });
    expect(imp.status).toBe(403);

    // support SÍ puede LEER (la lectura no está restringida).
    const read = await request(app.getHttpServer())
      .get('/admin/tenants/at-risk')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(read.status).toBe(200);

    // superadmin sí puede suspender (dominio propio del rol).
    const superSusp = await request(app.getHttpServer())
      .post(`/admin/tenants/${owner.tenantId}/suspend`)
      .set('Authorization', `Bearer ${superToken}`)
      .send({ reason: 'test' });
    expect(superSusp.status).toBe(200);
  });

  it('desactivar un super admin invalida su access token vivo de inmediato', async () => {
    // El token del support funciona para leer ahora.
    const before = await request(app.getHttpServer())
      .get('/admin/tenants/at-risk')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(before.status).toBe(200);

    // El superadmin lo desactiva.
    await adminClient.superAdmin.update({ where: { id: supportId }, data: { isActive: false } });

    // El mismo token ya no vale (antes seguía vivo hasta expirar).
    const after = await request(app.getHttpServer())
      .get('/admin/tenants/at-risk')
      .set('Authorization', `Bearer ${supportToken}`);
    expect(after.status).toBe(401);
  });
});
