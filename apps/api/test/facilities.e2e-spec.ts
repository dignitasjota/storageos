import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Facilities + UnitTypes (e2e)', () => {
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

  it('CRUD facility con soft delete', async () => {
    const owner = await registerVerifiedUser(app, 'fac-crud');
    const create = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Centro', city: 'Madrid' });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const list = await request(app.getHttpServer())
      .get('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Local Centro');

    const update = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Local Norte' });
    expect(update.status).toBe(200);
    expect(update.body.name).toBe('Local Norte');

    const del = await request(app.getHttpServer())
      .delete(`/facilities/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(del.status).toBe(204);

    const listAfter = await request(app.getHttpServer())
      .get('/facilities')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(listAfter.body).toHaveLength(0);
  });

  it('horario de apertura: se guarda por día y se puede vaciar', async () => {
    const owner = await registerVerifiedUser(app, 'fac-hours');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const create = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Horario' });
    expect(create.status).toBe(201);
    expect(create.body.openingHours).toEqual({});
    const id = create.body.id;

    const update = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({
        openingHours: {
          mon: { open: '09:00', close: '20:00' },
          tue: { open: '09:00', close: '20:00' },
          wed: { open: '09:00', close: '20:00' },
          thu: { open: '09:00', close: '20:00' },
          fri: { open: '09:00', close: '20:00' },
          sat: { open: '10:00', close: '14:00' },
          sun: null,
        },
      });
    expect(update.status).toBe(200);
    expect(update.body.openingHours.mon).toEqual({ open: '09:00', close: '20:00' });
    expect(update.body.openingHours.sun).toBeNull();

    // Hora inválida -> 400.
    const invalid = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({ openingHours: { mon: { open: '9:00', close: '20:00' } } });
    expect(invalid.status).toBe(400);

    // Vaciar (todos los días a null) se refleja tal cual.
    const cleared = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({ openingHours: {} });
    expect(cleared.status).toBe(200);
    expect(cleared.body.openingHours).toEqual({});
  });

  it('vídeo del local: se guarda, valida formato de URL y se puede quitar', async () => {
    const owner = await registerVerifiedUser(app, 'fac-video');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const create = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Vídeo' });
    expect(create.status).toBe(201);
    expect(create.body.videoUrl).toBeNull();
    const id = create.body.id;

    const update = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({ videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(update.status).toBe(200);
    expect(update.body.videoUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    // No es una URL -> 400.
    const invalid = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({ videoUrl: 'no es una url' });
    expect(invalid.status).toBe(400);

    // Vaciar -> null.
    const cleared = await request(app.getHttpServer())
      .patch(`/facilities/${id}`)
      .set(auth)
      .send({ videoUrl: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.videoUrl).toBeNull();
  });

  it('unit_type duplicado por tenant -> 409', async () => {
    const owner = await registerVerifiedUser(app, 'ut-dup');
    const first = await request(app.getHttpServer())
      .post('/unit-types')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Pequeno', defaultPriceMonthly: 30, color: '#aabbcc' });
    expect(first.status).toBe(201);
    const dup = await request(app.getHttpServer())
      .post('/unit-types')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Pequeno', defaultPriceMonthly: 40, color: '#112233' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('unit_type_name_taken');
  });

  it('borrar unit_type con units asociadas lo desactiva en vez de borrar', async () => {
    const owner = await registerVerifiedUser(app, 'ut-deact');
    const { unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const del = await request(app.getHttpServer())
      .delete(`/unit-types/${unitTypeId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(del.status).toBe(204);
    const list = await request(app.getHttpServer())
      .get('/unit-types')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    const found = list.body.find((t: { id: string }) => t.id === unitTypeId);
    expect(found.isActive).toBe(false);
  });

  it('staff no puede crear facility (403)', async () => {
    const owner = await registerVerifiedUser(app, 'fac-staff');
    // Invitar a staff
    const inv = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: `staff-${Date.now()}@e2e.local`, role: 'staff' });
    expect(inv.status).toBe(201);
    // En vez de pasar por email, accedemos directamente a la BD para obtener el token via mailpit
    // shortcut: re-leer email
    const { waitForEmail, extractToken } = await import('./helpers/mailpit');
    const mail = await waitForEmail(inv.body.email, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');
    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Staff', password: 'Staff1234' });
    expect(accept.status).toBe(200);

    const staffRes = await request(app.getHttpServer())
      .post('/facilities')
      .set('Authorization', `Bearer ${accept.body.accessToken}`)
      .send({ name: 'No deberia' });
    expect(staffRes.status).toBe(403);
  });
});
