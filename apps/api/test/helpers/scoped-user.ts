import request from 'supertest';

import { extractToken, waitForEmail } from './mailpit';

import type { INestApplication } from '@nestjs/common';

/**
 * Invita a un usuario con ese rol, lo restringe a esos locales y devuelve su
 * cabecera de autorización (con el alcance ya en el token).
 */
export async function scopedUser(
  app: INestApplication,
  owner: { slug: string; accessToken: string },
  opts: { role: 'manager' | 'staff' | 'readonly'; facilityIds: string[]; tag?: string },
): Promise<{ Authorization: string }> {
  const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
  const email = `${opts.tag ?? 'scoped'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const password = 'Passw0rd!';
  await request(app.getHttpServer())
    .post('/invitations')
    .set(ownerAuth)
    .send({ email, role: opts.role })
    .expect(201);
  const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
  const inviteToken = extractToken(mail.Text, '/invite');
  await request(app.getHttpServer())
    .post(`/invitations/token/${inviteToken}/accept`)
    .send({ fullName: 'Usuario con alcance', password })
    .expect(200);
  const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
  const user = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
  if (!user) throw new Error(`usuario ${email} no encontrado`);
  await request(app.getHttpServer())
    .patch(`/settings/users/${user.id}/facilities`)
    .set(ownerAuth)
    .send({ facilityIds: opts.facilityIds })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ tenantSlug: owner.slug, email, password })
    .expect(200);
  return { Authorization: `Bearer ${login.body.accessToken as string}` };
}
