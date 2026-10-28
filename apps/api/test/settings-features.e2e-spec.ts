import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { DataRetentionService } from '../src/modules/data-retention/data-retention.service';
import { CustomDomainCheckService } from '../src/modules/users/custom-domain-check.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Configuración (PR B): sesiones, email, negocio, registro, dominio… */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Funcionalidades de Configuración (e2e)', () => {
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

  it('lista las sesiones y cierra las de los demás dispositivos', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat1');
    // Un segundo inicio de sesión (otro dispositivo).
    const second = await http()
      .post('/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')
      .send({ tenantSlug: owner.slug, email: owner.email, password: owner.password })
      .expect(200);
    expect(second.body.accessToken).toBeTruthy();

    const auth = { Authorization: `Bearer ${owner.accessToken}`, Cookie: owner.refreshCookie };
    const list = await http().get('/me/sessions').set(auth).expect(200);
    expect(list.body.length).toBeGreaterThanOrEqual(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const res = await http().post('/me/sessions/revoke-others').set(auth).expect(201);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);
    const after = await http().get('/me/sessions').set(auth).expect(200);
    expect(after.body).toHaveLength(1);
    expect(after.body[0].current).toBe(true);
  });

  it('cambia el email de acceso tras confirmar el enlace', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const newEmail = `nuevo-${Date.now()}@e2e.local`;

    const wrong = await http()
      .post('/me/email-change')
      .set(auth)
      .send({ newEmail, currentPassword: 'Mala1234' });
    expect(wrong.status).toBe(403);

    await http()
      .post('/me/email-change')
      .set(auth)
      .send({ newEmail, currentPassword: owner.password })
      .expect(201);
    const status = await http().get('/me/email-change').set(auth).expect(200);
    expect(status.body.pendingEmail).toBe(newEmail);

    const mail = await waitForEmail(newEmail, { subjectIncludes: 'Confirma tu nuevo email' });
    const token = extractToken(mail.Text, '/verify-email/change');
    const ok = await http().post('/email-change/confirm').send({ token }).expect(200);
    expect(ok.body.email).toBe(newEmail);

    const user = await db.user.findUnique({ where: { id: owner.userId } });
    expect(user?.email).toBe(newEmail);
    expect(user?.pendingEmail).toBeNull();
    // Un solo uso.
    const again = await http().post('/email-change/confirm').send({ token });
    expect(again.status).toBe(400);
  });

  it('guarda el contacto del negocio y avisa de lo que falta configurar', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await http()
      .patch('/settings/tenant/profile')
      .set(auth)
      .send({ contactPhone: '+34 600 111 222', contactEmail: 'Hola@Negocio.es' })
      .expect(200);
    expect(res.body).toMatchObject({
      contactPhone: '+34 600 111 222',
      contactEmail: 'hola@negocio.es',
    });

    const health = await http().get('/settings/tenant/health').set(auth).expect(200);
    const keys = health.body.map((i: { key: string }) => i.key);
    expect(keys).toContain('company_data');
    expect(keys).toContain('no_payment_method');
    expect(keys).not.toContain('no_default_series');
  });

  it('filtra el registro de actividad y devuelve los cambios', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat4');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .patch('/settings/tenant/profile')
      .set(auth)
      .send({ name: 'Otro nombre' })
      .expect(200);

    const res = await http()
      .get(`/audit-logs?action=tenant.profile&userId=${owner.userId}`)
      .set(auth)
      .expect(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(
      res.body.items.every((i: { action: string }) => i.action.startsWith('tenant.profile')),
    ).toBe(true);
    expect(res.body.items[0].changes).toBeTruthy();

    const bad = await http().get('/audit-logs?from=ayer').set(auth);
    expect(bad.status).toBe(400);
  });

  it('avisa al super admin cuando el dominio propio ya apunta', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat5');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const domain = `ready-${Date.now()}.e2e-test.es`;
    await http()
      .patch('/settings/tenant/branding')
      .set(auth)
      .send({ customDomain: domain })
      .expect(200);

    const r = await http().post('/settings/tenant/domain/check').set(auth).expect(200);
    expect(r.body).toMatchObject({ domain, pointsToPlatform: true });
    expect(r.body.readyAt).not.toBeNull();
    // Volver a comprobar (o el cron) no repite el aviso.
    await http().post('/settings/tenant/domain/check').set(auth).expect(200);
    await app.get(CustomDomainCheckService).checkPending();
    const notes = await db.superAdminNotification.count({
      where: { type: 'custom_domain.ready', title: { contains: domain } },
    });
    expect(notes).toBe(1);
  });

  it('borra las invitaciones caducadas hace más de 90 días', async () => {
    const owner = await registerVerifiedUser(app, 'setfeat6');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const inv = await http()
      .post('/invitations')
      .set(auth)
      .send({ email: `vieja-${Date.now()}@e2e.local`, role: 'staff' })
      .expect(201);
    await db.invitation.update({
      where: { id: inv.body.id },
      data: { expiresAt: new Date(Date.now() - 100 * 86_400_000) },
    });
    await app.get(DataRetentionService).cleanupStaleInvitations();
    expect(await db.invitation.findUnique({ where: { id: inv.body.id } })).toBeNull();
  });
});
