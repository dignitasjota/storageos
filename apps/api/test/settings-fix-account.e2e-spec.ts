import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';
import { generateTotpCode } from './helpers/totp';

import type { INestApplication } from '@nestjs/common';

/** DNI válido y distinto en cada llamada (el NIF no se repite entre empresas). */
function randomDni(): string {
  const n = Math.floor(10_000_000 + Math.random() * 89_999_999);
  return `${n}${'TRWAGMYFPDXBNJZSQVHLCKE'[n % 23]}`;
}

function refreshCookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  return (list.find((c) => c?.startsWith('refresh_token=')) ?? '').split(';')[0] ?? '';
}

describe('Configuración: tu cuenta y equipo (arreglos)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  // La conexión de administración de la propia app (sin abrir otra por consulta).
  const withDb = <T>(fn: (db: PrismaAdminService) => Promise<T>): Promise<T> =>
    fn(app.get(PrismaAdminService));

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function login(owner: VerifiedUser, email = owner.email, password = owner.password) {
    const res = await http()
      .post('/auth/login')
      .set('User-Agent', `device-${Math.random()}`)
      .send({ tenantSlug: owner.slug, email, password })
      .expect(200);
    return { token: res.body.accessToken as string, cookie: refreshCookieOf(res) };
  }

  async function invite(
    owner: VerifiedUser,
    role: 'manager' | 'staff' | 'readonly',
    token = owner.accessToken,
  ) {
    const email = `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
    const password = 'Passw0rd!';
    await http().post('/invitations').set(auth(token)).send({ email, role }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await http()
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Del equipo', password })
      .expect(200);
    const users = await http().get('/users').set(auth(owner.accessToken));
    const user = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    return { id: user.id, email, password };
  }

  it('cerrar la sesión de otro dispositivo (o una caducada) no expulsa al resto', async () => {
    const owner = await registerVerifiedUser(app, 'acc-sessions');
    const a = await login(owner);
    const b = await login(owner);

    const sessions = await http().get('/me/sessions').set(auth(a.token)).set('Cookie', a.cookie);
    const other = (sessions.body as { id: string; current: boolean }[]).find(
      (s) => !s.current && b.cookie.includes(s.id),
    );
    expect(other).toBeTruthy();
    await http().delete(`/me/sessions/${other!.id}`).set(auth(a.token)).expect(204);

    // El dispositivo cerrado intenta renovar: 401, sin cerrar los demás.
    await http().post('/auth/refresh').set('Cookie', b.cookie).expect(401);
    const renewA = await http().post('/auth/refresh').set('Cookie', a.cookie).expect(200);
    const a2 = refreshCookieOf(renewA);

    // Cerrar «las demás» tampoco castiga a quien lo pide.
    const c = await login(owner);
    await http()
      .post('/me/sessions/revoke-others')
      .set(auth(renewA.body.accessToken as string))
      .set('Cookie', a2)
      .expect(201);
    await http().post('/auth/refresh').set('Cookie', c.cookie).expect(401);
    const renewA2 = await http().post('/auth/refresh').set('Cookie', a2).expect(200);

    // Una sesión caducada (sin rotar) da 401 y las demás siguen.
    const d = await login(owner);
    const dId = d.cookie.split('.')[1]!;
    await withDb((db) =>
      db.session.update({ where: { id: dId }, data: { expiresAt: new Date(Date.now() - 1000) } }),
    );
    await http().post('/auth/refresh').set('Cookie', d.cookie).expect(401);
    await http().post('/auth/refresh').set('Cookie', refreshCookieOf(renewA2)).expect(200);

    const reuse = await withDb((db) =>
      db.session.count({ where: { userId: owner.userId, revokedReason: 'refresh_reuse' } }),
    );
    expect(reuse).toBe(0);
  });

  it('roles a medida, locales y propiedad: solo el propietario; nunca a uno mismo; auditado', async () => {
    const owner = await registerVerifiedUser(app, 'acc-escalate');
    const staff = await invite(owner, 'staff');

    // Rol a medida con gestión de usuarios y ajustes, asignado a una persona del equipo.
    const role = await http()
      .post('/settings/roles')
      .set(auth(owner.accessToken))
      .send({
        name: 'Casi propietario',
        permissions: ['users:read', 'users:manage', 'settings:read', 'settings:manage'],
      })
      .expect(201);
    await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(auth(owner.accessToken))
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    const s = await login(owner, staff.email, staff.password);

    const create = await http()
      .post('/settings/roles')
      .set(auth(s.token))
      .send({ name: 'Todo', permissions: ['invoices:refund'] });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('owner_only');

    const selfAssign = await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(auth(s.token))
      .send({ tenantRoleId: null });
    expect(selfAssign.status).toBe(403);

    const transfer = await http().post(`/users/${staff.id}/transfer-ownership`).set(auth(s.token));
    expect([400, 403]).toContain(transfer.status);
    const users = await http().get('/users').set(auth(owner.accessToken));
    const ownerId = (users.body as { id: string; role: string }[]).find(
      (u) => u.role === 'owner',
    )!.id;
    const transfer2 = await http().post(`/users/${ownerId}/transfer-ownership`).set(auth(s.token));
    expect(transfer2.status).toBe(403);
    expect(transfer2.body.code).toBe('owner_only');

    // Invitar como gestor: solo el propietario.
    const asManager = await http()
      .post('/invitations')
      .set(auth(s.token))
      .send({ email: `mgr-${Date.now()}@e2e.local`, role: 'manager' });
    expect(asManager.status).toBe(403);
    expect(asManager.body.code).toBe('insufficient_role');

    // El propietario tampoco se asigna locales a sí mismo.
    const selfFacilities = await http()
      .patch(`/settings/users/${ownerId}/facilities`)
      .set(auth(owner.accessToken))
      .send({ facilityIds: [] });
    expect(selfFacilities.status).toBe(400);
    expect(selfFacilities.body.code).toBe('cannot_target_self');

    // Editar los permisos del rol corta el token de quien lo tiene.
    await http().get('/auth/me').set(auth(s.token)).expect(200);
    await http()
      .patch(`/settings/roles/${role.body.id}`)
      .set(auth(owner.accessToken))
      .send({ permissions: ['users:read'], description: '' })
      .expect(200);
    const outdated = await http().get('/auth/me').set(auth(s.token));
    expect(outdated.status).toBe(401);
    expect(outdated.body.code).toBe('session_outdated');

    const actions = await withDb((db) =>
      db.auditLog.findMany({
        where: { tenantId: owner.tenantId, action: { startsWith: 'tenant_role.' } },
        select: { action: true },
      }),
    );
    expect(actions.map((a) => a.action).sort()).toEqual([
      'tenant_role.created',
      'tenant_role.updated',
    ]);
    const assigned = await withDb((db) =>
      db.auditLog.count({
        where: { tenantId: owner.tenantId, action: 'user.tenant_role_changed' },
      }),
    );
    expect(assigned).toBe(1);
  });

  it('reenviar una invitación caducada y reactivar a alguien respetan el límite del plan', async () => {
    const owner = await registerVerifiedUser(app, 'acc-limits');
    await withDb(async (db) => {
      const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { slug: 'free' } });
      await db.tenantSubscription.update({
        where: { tenantId: owner.tenantId },
        data: { planId: plan.id },
      }); // 2 usuarios
    });
    const staff = await invite(owner, 'staff');

    // Invitación caducada (no ocupa plaza) → reenviarla sí la ocuparía.
    const expiredEmail = `exp-${Date.now()}@e2e.local`;
    const inv = await withDb((db) =>
      db.invitation.create({
        data: {
          tenantId: owner.tenantId,
          email: expiredEmail,
          role: 'staff',
          invitedByUserId: owner.userId,
          tokenHash: 'x',
          expiresAt: new Date(Date.now() - 60_000),
        },
      }),
    );
    const resend = await http().post(`/invitations/${inv.id}/resend`).set(auth(owner.accessToken));
    expect(resend.status).toBe(403);
    expect(resend.body.code).toBe('users_limit_reached');

    // Desactivar y reactivar con el tope ocupado por otra persona.
    await http().delete(`/users/${staff.id}`).set(auth(owner.accessToken)).expect(204);
    await withDb((db) =>
      db.user.create({
        data: {
          tenantId: owner.tenantId,
          email: `other-${Date.now()}@e2e.local`,
          passwordHash: 'x',
          fullName: 'Otra',
          role: 'staff',
          isActive: true,
          emailVerifiedAt: new Date(),
        },
      }),
    );
    const reactivate = await http()
      .patch(`/users/${staff.id}`)
      .set(auth(owner.accessToken))
      .send({ isActive: true });
    expect(reactivate.status).toBe(403);
    expect(reactivate.body.code).toBe('users_limit_reached');
  });

  it('cambiar la contraseña anula el cambio de email pendiente', async () => {
    const owner = await registerVerifiedUser(app, 'acc-email');
    await http()
      .post('/me/email-change')
      .set(auth(owner.accessToken))
      .send({ currentPassword: owner.password, newEmail: `nuevo-${Date.now()}@e2e.local` })
      .expect(201);
    const pending = await http().get('/me/email-change').set(auth(owner.accessToken));
    expect(pending.body.pendingEmail).not.toBeNull();

    await http()
      .post('/me/change-password')
      .set(auth(owner.accessToken))
      .send({ currentPassword: owner.password, newPassword: 'OtraClave123' })
      .expect(204);
    const after = await http().get('/me/email-change').set(auth(owner.accessToken));
    expect(after.body.pendingEmail).toBeNull();
  });

  it('verificación en dos pasos obligatoria: se aplica al renovar y no se puede quitar', async () => {
    const owner = await registerVerifiedUser(app, 'acc-2fa');

    // El código de la app de autenticación lleva la marca, no el remitente de correo.
    const setup = await http().post('/auth/2fa/setup').set(auth(owner.accessToken)).expect(201);
    expect(setup.body.otpauthUri as string).toContain('issuer=TrasterOS');

    // Sin 2FA y con la regla activa: la renovación pide activarla y borra la cookie.
    await http()
      .patch('/settings/tenant/security')
      .set(auth(owner.accessToken))
      .send({ requireTwoFactorForManagers: true })
      .expect(200);
    const blocked = await http().post('/auth/refresh').set('Cookie', owner.refreshCookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('two_factor_enrolment_required');
    expect(typeof blocked.body.details?.enrolmentToken).toBe('string');
    expect(String(blocked.headers['set-cookie'])).toContain('refresh_token=;');

    // Con 2FA activada, no se puede quitar mientras la regla siga activa.
    const secret = setup.body.secretBase32 as string;
    await http()
      .post('/auth/2fa/verify')
      .set(auth(owner.accessToken))
      .send({ code: generateTotpCode(secret) })
      .expect(200);
    const disable = await http()
      .post('/auth/2fa/disable')
      .set(auth(owner.accessToken))
      .send({ currentPassword: owner.password, code: generateTotpCode(secret) });
    expect(disable.status).toBe(400);
    expect(disable.body.code).toBe('two_factor_required_by_policy');
  });

  it('el NIF no cambia con facturas emitidas y los datos fiscales quedan en el registro', async () => {
    const owner = await registerVerifiedUser(app, 'acc-taxid');
    const body = (taxId: string) => ({
      legalName: 'Trasteros Cuenta SL',
      taxId,
      address: 'C/ Uno 1',
      city: 'Valencia',
      postalCode: '46001',
    });
    await http()
      .post('/settings/saas-billing/billing-details')
      .set(auth(owner.accessToken))
      .send(body(randomDni()))
      .expect(200);

    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await withDb((db) =>
      db.invoice.update({ where: { id: invoiceId }, data: { status: 'issued' } }),
    );
    const locked = await http()
      .post('/settings/saas-billing/billing-details')
      .set(auth(owner.accessToken))
      .send(body(randomDni()));
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('tax_id_locked');

    const logs = await withDb((db) =>
      db.auditLog.count({
        where: { tenantId: owner.tenantId, action: 'tenant.billing_details_changed' },
      }),
    );
    expect(logs).toBe(1);
  });

  it('el mismo navegador suscrito al push en otra empresa pasa a esta sin error', async () => {
    const a = await registerVerifiedUser(app, 'acc-push-a');
    const b = await registerVerifiedUser(app, 'acc-push-b');
    const endpoint = `https://push.example.com/device-${Date.now()}`;
    const sub = { endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } };
    await http().post('/me/push/subscribe').set(auth(a.accessToken)).send(sub).expect(204);
    await http().post('/me/push/subscribe').set(auth(b.accessToken)).send(sub).expect(204);
    const rows = await withDb((db) =>
      db.pushSubscription.findMany({ where: { endpoint }, select: { tenantId: true } }),
    );
    expect(rows).toEqual([{ tenantId: b.tenantId }]);
  });
});
