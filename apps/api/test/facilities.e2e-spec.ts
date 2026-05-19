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
