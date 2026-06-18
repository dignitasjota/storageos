import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const RANDOM_UUID = '00000000-0000-7000-8000-000000000000';

async function inviteStaff(
  app: INestApplication,
  ownerToken: string,
): Promise<{ token: string; email: string; password: string }> {
  const email = `staff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const password = 'Passw0rd!';
  const inv = await request(app.getHttpServer())
    .post('/invitations')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role: 'staff' });
  if (inv.status !== 201) throw new Error(`invite ${inv.status}: ${JSON.stringify(inv.body)}`);
  const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
  const token = extractToken(mail.Text, '/invite');
  const accept = await request(app.getHttpServer())
    .post(`/invitations/token/${token}/accept`)
    .send({ fullName: 'Staff', password });
  if (accept.status !== 200) throw new Error(`accept ${accept.status}`);
  return { token: accept.body.accessToken as string, email, password };
}

describe('Roles personalizados por tenant (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('CRUD de roles: crear, listar, nombre duplicado 409, permiso inválido 400, borrar', async () => {
    const owner = await registerVerifiedUser(app, 'roles-crud');

    const create = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Contable',
        permissions: ['invoices:read', 'invoices:refund'],
        baseRole: 'staff',
      });
    expect(create.status).toBe(201);
    expect(create.body.permissions).toEqual(['invoices:read', 'invoices:refund']);
    expect(create.body.userCount).toBe(0);
    const roleId = create.body.id as string;

    const list = await request(app.getHttpServer())
      .get('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((r: { id: string }) => r.id === roleId)).toBe(true);

    const dup = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Contable', permissions: [] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('role_name_taken');

    const invalid = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Roto', permissions: ['no:existe'] });
    expect(invalid.status).toBe(400);

    const del = await request(app.getHttpServer())
      .delete(`/settings/roles/${roleId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(del.status).toBe(204);
  });

  it('staff sin rol custom no puede refund; con rol custom que lo incluye, sí pasa el guard', async () => {
    const owner = await registerVerifiedUser(app, 'roles-grant');
    const staff = await inviteStaff(app, owner.accessToken);

    // Staff base (enum) no tiene invoices:refund → 403.
    const before = await request(app.getHttpServer())
      .post(`/invoices/${RANDOM_UUID}/refund`)
      .set('Authorization', `Bearer ${staff.token}`)
      .send({ amount: 10 });
    expect(before.status).toBe(403);
    expect(before.body.code).toBe('insufficient_permission');

    // Owner crea rol con invoices:refund y lo asigna al staff.
    const role = await request(app.getHttpServer())
      .post('/settings/roles')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        name: 'Reembolsos',
        permissions: ['invoices:read', 'invoices:refund'],
        baseRole: 'staff',
      });
    expect(role.status).toBe(201);

    // Necesitamos el userId del staff: lo sacamos de /users.
    const users = await request(app.getHttpServer())
      .get('/users')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const staffUser = (users.body as { id: string; email: string }[]).find(
      (u) => u.email === staff.email,
    );
    expect(staffUser).toBeTruthy();

    const assign = await request(app.getHttpServer())
      .patch(`/settings/users/${staffUser!.id}/tenant-role`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ tenantRoleId: role.body.id });
    expect(assign.status).toBe(204);

    // El token viejo aún tiene permisos del enum; re-login para token nuevo.
    const relogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: staff.email, password: staff.password });
    expect(relogin.status).toBe(200);
    const newToken = relogin.body.accessToken as string;

    // /auth/me ahora refleja los permisos del rol custom.
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${newToken}`);
    expect(me.body.permissions).toContain('invoices:refund');

    // Y el guard de refund ya no devuelve 403 (404/400 por factura inexistente).
    const after = await request(app.getHttpServer())
      .post(`/invoices/${RANDOM_UUID}/refund`)
      .set('Authorization', `Bearer ${newToken}`)
      .send({ amount: 10 });
    expect(after.status).not.toBe(403);
    expect([400, 404]).toContain(after.status);
  });

  it('un no-owner no puede gestionar roles (403)', async () => {
    const owner = await registerVerifiedUser(app, 'roles-guard');
    const staff = await inviteStaff(app, owner.accessToken);
    const res = await request(app.getHttpServer())
      .get('/settings/roles')
      .set('Authorization', `Bearer ${staff.token}`);
    expect(res.status).toBe(403);
  });
});
