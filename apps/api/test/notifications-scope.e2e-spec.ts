import request from 'supertest';

import { NotificationsService } from '../src/modules/notifications/notifications.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

type NotifList = {
  items: { id: string; title: string; readAt: string | null }[];
  unreadCount: number;
};

/**
 * Avisos al equipo con alcance por local: un gerente restringido al local A no
 * ve las notificaciones del B ni recibe sus correos; y el leído es por usuario.
 */
describe('Notificaciones y avisos al equipo por local (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('alcance por local y leído por usuario', async () => {
    const owner = await registerVerifiedUser(app, 'notifscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 1,
    });

    // Gerente restringido al local A.
    const email = `ns-mgr-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'manager' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await request(app.getHttpServer())
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Gerente A', password })
      .expect(200);
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const mgr = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    await request(app.getHttpServer())
      .patch(`/settings/users/${mgr.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password })
      .expect(200);
    const mgrAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // Una de cada: local A, local B y de empresa.
    const notifications = app.get(NotificationsService);
    const me = await request(app.getHttpServer()).get('/auth/me').set(ownerAuth);
    const tenantId = me.body.tenant.id as string;
    await notifications.create(tenantId, {
      type: 't',
      title: 'Aviso A',
      facilityId: facA.facilityId,
    });
    await notifications.create(tenantId, {
      type: 't',
      title: 'Aviso B',
      facilityId: facB.facilityId,
    });
    await notifications.create(tenantId, { type: 't', title: 'Aviso empresa' });

    const list = async (auth: Record<string, string>) =>
      (await request(app.getHttpServer()).get('/notifications').set(auth).expect(200))
        .body as NotifList;

    const mgrList = await list(mgrAuth);
    const mgrTitles = mgrList.items.map((n) => n.title);
    expect(mgrTitles).toEqual(expect.arrayContaining(['Aviso A', 'Aviso empresa']));
    expect(mgrTitles).not.toContain('Aviso B');
    const ownerList = await list(ownerAuth);
    expect(ownerList.items.map((n) => n.title)).toEqual(
      expect.arrayContaining(['Aviso A', 'Aviso B', 'Aviso empresa']),
    );

    // El gerente marca todo leído: el propietario sigue con las suyas sin leer.
    const ownerUnreadBefore = ownerList.unreadCount;
    await request(app.getHttpServer()).post('/notifications/read-all').set(mgrAuth).expect(204);
    expect((await list(mgrAuth)).unreadCount).toBe(0);
    expect((await list(ownerAuth)).unreadCount).toBe(ownerUnreadBefore);

    // Y no puede marcar como leída una de un local que no ve.
    const avisoB = ownerList.items.find((n) => n.title === 'Aviso B')!;
    await request(app.getHttpServer())
      .post(`/notifications/${avisoB.id}/read`)
      .set(mgrAuth)
      .expect(204);
    const ownerAfter = await list(ownerAuth);
    expect(ownerAfter.items.find((n) => n.id === avisoB.id)!.readAt).toBeNull();

    // Correo al equipo: un contacto de la web interesado en el local B solo
    // llega al propietario, no al gerente del A.
    await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Web',
        email: `ns-lead-${Date.now()}@e2e.local`,
        phone: '600000000',
        preferredFacilityId: facB.facilityId,
        acceptsTerms: true,
      })
      .expect(201);
    await waitForEmail(owner.email, { subjectIncludes: 'Nuevo contacto' });
    await expect(
      waitForEmail(email, { subjectIncludes: 'Nuevo contacto', timeoutMs: 3000 }),
    ).rejects.toThrow();
  }, 60_000);
});
