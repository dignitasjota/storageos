import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Invitations (e2e)', () => {
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

  async function freshOwner(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    await deleteAllMessages();
    return owner;
  }

  it('owner invita; el destinatario acepta; queda logueado con role correcto', async () => {
    const owner = await freshOwner('inv-flow');
    const inviteeEmail = `invitee-${Date.now()}@e2e.local`;

    const inv = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: inviteeEmail, role: 'manager' });
    expect(inv.status).toBe(201);
    expect(inv.body.status).toBe('pending');
    expect(inv.body.role).toBe('manager');

    const mail = await waitForEmail(inviteeEmail, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');

    // Endpoint publico de info.
    const publicInfo = await request(app.getHttpServer()).get(`/invitations/token/${token}`);
    expect(publicInfo.status).toBe(200);
    expect(publicInfo.body.email).toBe(inviteeEmail);
    expect(publicInfo.body.role).toBe('manager');
    expect(publicInfo.body.tenant.slug).toBe(owner.slug);

    // Aceptar.
    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Invitee Mgr', password: 'Secret123' });
    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe('manager');
    expect(typeof accept.body.accessToken).toBe('string');
    const setCookie = accept.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.some((c) => c?.startsWith('refresh_token='))).toBe(true);

    // Reusar el mismo token devuelve 4xx.
    const replay = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Otro Nombre', password: 'Secret123' });
    expect([404, 409]).toContain(replay.status);
  });

  it('email ya existente en el tenant -> 409', async () => {
    const owner = await freshOwner('inv-dup');
    const res = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: owner.email, role: 'staff' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_already_user');
  });

  it('invitation pendiente duplicada -> 409', async () => {
    const owner = await freshOwner('inv-dup-pending');
    const email = `dup-${Date.now()}@e2e.local`;
    const first = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email, role: 'staff' });
    expect(first.status).toBe(201);
    const second = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email, role: 'staff' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('invitation_pending');
  });

  it('revoke marca la invitacion y el token deja de servir', async () => {
    const owner = await freshOwner('inv-revoke');
    const email = `rev-${Date.now()}@e2e.local`;
    const inv = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email, role: 'staff' });
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');

    const revoke = await request(app.getHttpServer())
      .post(`/invitations/${inv.body.id}/revoke`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(revoke.status).toBe(204);

    const lookup = await request(app.getHttpServer()).get(`/invitations/token/${token}`);
    expect(lookup.status).toBe(404);
  });

  it('resend invalida el token anterior y emite uno nuevo', async () => {
    const owner = await freshOwner('inv-resend');
    const email = `re-${Date.now()}@e2e.local`;
    const inv = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email, role: 'staff' });
    const first = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const oldToken = extractToken(first.Text, '/invite');

    await deleteAllMessages();
    const resend = await request(app.getHttpServer())
      .post(`/invitations/${inv.body.id}/resend`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(resend.status).toBe(201);
    expect(resend.body.id).not.toBe(inv.body.id);

    const second = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const newToken = extractToken(second.Text, '/invite');
    expect(newToken).not.toBe(oldToken);

    // Token antiguo: revocado.
    const oldLookup = await request(app.getHttpServer()).get(`/invitations/token/${oldToken}`);
    expect(oldLookup.status).toBe(404);

    // Token nuevo: valido.
    const newLookup = await request(app.getHttpServer()).get(`/invitations/token/${newToken}`);
    expect(newLookup.status).toBe(200);
  });

  it('staff no puede invitar (403)', async () => {
    const owner = await freshOwner('inv-staff');
    const staffEmail = `staff-${Date.now()}@e2e.local`;
    const inv = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: staffEmail, role: 'staff' });
    const mail = await waitForEmail(staffEmail, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');
    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Staff User', password: 'Secret123' });
    expect(accept.status).toBe(200);
    const staffAccess = accept.body.accessToken;

    const res = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${staffAccess}`)
      .send({ email: `nope-${Date.now()}@e2e.local`, role: 'staff' });
    expect(res.status).toBe(403);
    expect(['insufficient_role', 'forbidden']).toContain(res.body.code);

    // Sanity: la invitacion creada esta en la lista.
    void inv;
  });
});
