import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Mejoras de Configuración: equipo, registro de actividad y protección de datos. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/** Hoy (AAAA-MM-DD) en Madrid, desplazado `days` días. */
function madridDay(days = 0): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
}

describe('Mejoras de Configuración: equipo y protección de datos (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  it('cuenta las plazas del plan: usuarios activos + invitaciones pendientes', async () => {
    const owner = await registerVerifiedUser(app, 'impteam1');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const before = await http().get('/users/limits').set(auth).expect(200);
    expect(before.body).toMatchObject({ used: 1, activeUsers: 1, pendingInvitations: 0 });

    await http()
      .post('/invitations')
      .set(auth)
      .send({ email: `plaza-${Date.now()}@e2e.local`, role: 'staff' })
      .expect(201);
    const after = await http().get('/users/limits').set(auth).expect(200);
    expect(after.body).toMatchObject({ used: 2, activeUsers: 1, pendingInvitations: 1 });

    const tenant = await db.tenant.findUniqueOrThrow({
      where: { slug: owner.slug },
      include: { subscription: { include: { plan: true } } },
    });
    const planMax = tenant.subscription?.plan.maxUsers ?? null;
    if (planMax === null) expect(after.body.limit).toBeNull();
    else expect(after.body.limit).toBeGreaterThanOrEqual(planMax);
  });

  it('invita con rol a medida y locales, que se aplican al aceptar y se conservan al reenviar', async () => {
    const owner = await registerVerifiedUser(app, 'impteam2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const role = await http()
      .post('/settings/roles')
      .set(auth)
      .send({ name: 'Mostrador', permissions: ['customers:read'], baseRole: 'staff' })
      .expect(201);

    // Un local de otro negocio no vale.
    const other = await registerVerifiedUser(app, 'impteam2b');
    const foreign = await createFacilityWithUnits(app, other.accessToken, { unitsCount: 1 });
    const bad = await http()
      .post('/invitations')
      .set(auth)
      .send({
        email: `bad-${Date.now()}@e2e.local`,
        role: 'staff',
        facilityIds: [foreign.facilityId],
      });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('facility_not_found');

    const email = `medida-${Date.now()}@e2e.local`;
    const inv = await http()
      .post('/invitations')
      .set(auth)
      .send({ email, role: 'staff', tenantRoleId: role.body.id, facilityIds: [facilityId] })
      .expect(201);
    expect(inv.body.tenantRoleName).toBe('Mostrador');
    expect(inv.body.facilityIds).toEqual([facilityId]);

    // Reenviar conserva lo elegido.
    const resent = await http().post(`/invitations/${inv.body.id}/resend`).set(auth).expect(201);
    expect(resent.body.tenantRoleId).toBe(role.body.id);
    expect(resent.body.facilityIds).toEqual([facilityId]);

    // Vale el enlace del reenvío (el primero queda revocado): se prueba el más
    // reciente hasta que entra.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
      const res = await http()
        .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
        .send({ fullName: 'Persona Mostrador', password: 'Secret123' });
      ok = res.status === 200;
      if (!ok) await new Promise((r) => setTimeout(r, 250));
    }
    expect(ok).toBe(true);
    const users = await http().get('/users').set(auth).expect(200);
    const created = (
      users.body as { email: string; tenantRoleId: string | null; facilityIds: string[] }[]
    ).find((u) => u.email === email);
    expect(created?.tenantRoleId).toBe(role.body.id);
    expect(created?.facilityIds).toEqual([facilityId]);
  });

  it('solo el propietario elige rol a medida o locales al invitar', async () => {
    const owner = await registerVerifiedUser(app, 'impteam3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    // Un gestor del negocio.
    const email = `gestor-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(auth).send({ email, role: 'manager' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const accepted = await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Gestor', password: 'Secret123' })
      .expect(200);
    const managerAuth = { Authorization: `Bearer ${accepted.body.accessToken as string}` };
    const res = await http()
      .post('/invitations')
      .set(managerAuth)
      .send({ email: `x-${Date.now()}@e2e.local`, role: 'staff', facilityIds: [facilityId] });
    // `users:manage` es del propietario: el gestor ni siquiera invita.
    expect(res.status).toBe(403);
  });

  it('el propietario quita el 2FA a un empleado: sesiones cerradas, códigos fuera y aviso', async () => {
    const owner = await registerVerifiedUser(app, 'impteam4');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `movil-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(auth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Empleado Sin Móvil', password: 'Secret123' })
      .expect(200);
    const user = await db.user.findFirstOrThrow({ where: { email } });

    // Sin 2FA: 400.
    const none = await http().post(`/users/${user.id}/disable-2fa`).set(auth);
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('two_factor_not_enabled');

    await db.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorSecretEncrypted: 'cifrado-de-prueba' },
    });
    await db.recoveryCode.create({
      data: { tenantId: user.tenantId, userId: user.id, codeHash: 'hash-de-prueba' },
    });

    // A sí mismo no.
    const ownerUser = await db.user.findFirstOrThrow({ where: { email: owner.email } });
    const self = await http().post(`/users/${ownerUser.id}/disable-2fa`).set(auth);
    expect(self.status).toBe(400);

    await http().post(`/users/${user.id}/disable-2fa`).set(auth).expect(204);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.twoFactorEnabled).toBe(false);
    expect(after.twoFactorSecretEncrypted).toBeNull();
    expect(await db.recoveryCode.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    const audit = await db.auditLog.findFirst({
      where: { action: 'user.two_factor_reset_by_owner', entityId: user.id },
    });
    expect(audit).not.toBeNull();
    await waitForEmail(email, { subjectIncludes: 'verificación en dos pasos' });
  });

  it('el registro de actividad oculta las sesiones salvo que se pidan', async () => {
    const owner = await registerVerifiedUser(app, 'impteam5');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email: owner.email, password: owner.password })
      .expect(200);
    const hidden = await http().get('/audit-logs').set(auth).expect(200);
    const actions = (hidden.body.items as { action: string }[]).map((a) => a.action);
    expect(actions).not.toContain('auth.login.success');
    const shown = await http().get('/audit-logs?sessions=1').set(auth).expect(200);
    const all = (shown.body.items as { action: string }[]).map((a) => a.action);
    expect(all.some((a) => a === 'auth.login.success' || a === 'auth.refresh')).toBe(true);
  });

  it('protección de datos: fecha de recepción, motivo al denegar y vista previa', async () => {
    const owner = await registerVerifiedUser(app, 'impteam6');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `titular-${Date.now()}@e2e.local`,
    });

    const future = await http()
      .post('/rgpd/requests')
      .set(auth)
      .send({ email: 'a@e2e.local', requestType: 'access', receivedAt: madridDay(2) });
    expect(future.status).toBe(400);
    expect(future.body.code).toBe('received_in_future');
    const old = await http()
      .post('/rgpd/requests')
      .set(auth)
      .send({ email: 'a@e2e.local', requestType: 'access', receivedAt: madridDay(-40) });
    expect(old.status).toBe(400);
    expect(old.body.code).toBe('received_too_old');

    const received = madridDay(-10);
    const created = await http()
      .post('/rgpd/requests')
      .set(auth)
      .send({
        email: 'titular@e2e.local',
        requestType: 'erasure',
        customerId,
        receivedAt: received,
      })
      .expect(201);
    expect(created.body.receivedAt).toBeTruthy();
    // El plazo cuenta desde la recepción: acaba antes de un mes desde hoy.
    expect(new Date(created.body.dueAt).getTime()).toBeLessThan(Date.now() + 25 * 86_400_000);

    const noReason = await http()
      .patch(`/rgpd/requests/${created.body.id}`)
      .set(auth)
      .send({ status: 'denied' });
    expect(noReason.status).toBe(400);

    const denied = await http()
      .patch(`/rgpd/requests/${created.body.id}`)
      .set(auth)
      .send({ status: 'denied', rejectionReason: 'Las facturas hay que conservarlas por ley.' })
      .expect(200);
    expect(denied.body.rejectionReason).toBe('Las facturas hay que conservarlas por ley.');
    const comm = await db.communication.findFirst({
      where: { source: 'rgpd.request_denied', recipient: 'titular@e2e.local' },
    });
    expect(comm?.bodyText).toContain('Agencia Española de Protección de Datos');
    expect(comm?.bodyText).toContain('Las facturas hay que conservarlas por ley.');

    const preview = await http()
      .get(`/rgpd/customers/${customerId}/anonymize-preview`)
      .set(auth)
      .expect(200);
    expect(preview.body.canAnonymize).toBe(true);
    expect(preview.body.blockers).toMatchObject({ liveContracts: 0, reservations: 0, debt: 0 });
    expect(preview.body.deleted[0].label).toBe('Datos personales de la ficha');
  });
});
