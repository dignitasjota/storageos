import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Permisos por local (facility scope) (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('un staff asignado a un local solo ve ese local, sus trasteros y su ocupación', async () => {
    const owner = await registerVerifiedUser(app, 'facscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };

    // Dos locales (A y B) con trasteros.
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 2,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 3,
    });

    // Invitar a un staff y aceptar.
    const email = `fs-staff-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await request(app.getHttpServer())
      .post('/invitations')
      .set(ownerAuth)
      .send({ email, role: 'staff' })
      .expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    const inviteToken = extractToken(mail.Text, '/invite');
    await request(app.getHttpServer())
      .post(`/invitations/token/${inviteToken}/accept`)
      .send({ fullName: 'Staff Scoped', password })
      .expect(200);

    // El owner asigna SOLO el local A al staff.
    const users = await request(app.getHttpServer()).get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email);
    expect(staff).toBeDefined();
    await request(app.getHttpServer())
      .patch(`/settings/users/${staff!.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);

    // El staff hace login → token fresco con el scope.
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password });
    expect(login.status).toBe(200);
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    // /auth/me refleja el scope.
    const me = await request(app.getHttpServer()).get('/auth/me').set(staffAuth);
    expect(me.body.facilityScope).toEqual([facA.facilityId]);

    // Solo ve el local A.
    const facs = await request(app.getHttpServer()).get('/facilities').set(staffAuth);
    expect(facs.body.map((f: { id: string }) => f.id)).toEqual([facA.facilityId]);

    // Solo ve los trasteros del local A (2), no los de B (3).
    const units = await request(app.getHttpServer()).get('/units').set(staffAuth);
    expect(units.body.items).toHaveLength(2);
    expect(
      (units.body.items as { facilityId: string }[]).every((u) => u.facilityId === facA.facilityId),
    ).toBe(true);

    // No puede ver el local B por id (404/403).
    const bById = await request(app.getHttpServer())
      .get(`/facilities/${facB.facilityId}`)
      .set(staffAuth);
    expect([403, 404]).toContain(bById.status);

    // Guards :id — no puede leer ni mutar un trastero del local B aunque conozca el id.
    const unitB = facB.unitIds[0]!;
    const readUnitB = await request(app.getHttpServer()).get(`/units/${unitB}`).set(staffAuth);
    expect(readUnitB.status).toBe(403);
    expect(readUnitB.body.code).toBe('facility_not_in_scope');

    const mutateUnitB = await request(app.getHttpServer())
      .post(`/units/${unitB}/change-status`)
      .set(staffAuth)
      .send({ status: 'maintenance', reason: 'x' });
    expect(mutateUnitB.status).toBe(403);

    // Un trastero del local A (asignado) sí lo lee.
    const readUnitA = await request(app.getHttpServer())
      .get(`/units/${facA.unitIds[0]!}`)
      .set(staffAuth);
    expect(readUnitA.status).toBe(200);

    // El owner (sin asignaciones) sigue viendo los dos locales.
    const ownerFacs = await request(app.getHttpServer()).get('/facilities').set(ownerAuth);
    expect(ownerFacs.body.length).toBeGreaterThanOrEqual(2);
  });
});
