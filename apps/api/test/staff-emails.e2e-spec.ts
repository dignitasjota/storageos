import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Avisos por email al equipo del tenant (propietarios y gestores). */
describe('Avisos por email al equipo (e2e)', () => {
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

  it('contacto desde el widget y reserva online llegan por email al propietario', async () => {
    const owner = await registerVerifiedUser(app, 'staffmail');
    await ensureDefaultSeries(app, owner.accessToken);
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Marta',
        email: `marta-${Date.now()}@e2e.local`,
        phone: '+34 600 111 222',
        message: '¿Tenéis trasteros de 5 m²?',
        hp: '',
        acceptsTerms: true,
        acceptsMarketing: false,
      })
      .expect(201);
    const lead = await waitForEmail(owner.email, { subjectIncludes: 'Nuevo contacto' });
    expect(lead.Text).toContain('Marta');
    expect(lead.Text).toContain('¿Tenéis trasteros de 5 m²?');
    expect(lead.Text).toContain('/leads');

    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-05-01',
        customer: { firstName: 'Ana', lastName: 'Ruiz', email: `ana-${Date.now()}@e2e.local` },
      })
      .expect(201);
    const booking = await waitForEmail(owner.email, { subjectIncludes: 'Reserva online' });
    expect(booking.Text).toContain('Ana Ruiz');
    expect(booking.Text).toContain('72 h');
  }, 90_000);

  it('un aviso apagado no se envía; los ajustes se leen y cambian', async () => {
    const owner = await registerVerifiedUser(app, 'staffoff');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const get = await request(app.getHttpServer())
      .get('/settings/tenant/staff-emails')
      .set(auth)
      .expect(200);
    expect(get.body).toEqual({
      new_lead: true,
      new_booking: true,
      move_out_requested: true,
      portal_incident: true,
    });
    await request(app.getHttpServer())
      .patch('/settings/tenant/staff-emails')
      .set(auth)
      .send({ new_lead: false })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/public/widget/${owner.slug}/leads`)
      .send({
        firstName: 'Pedro',
        email: `pedro-${Date.now()}@e2e.local`,
        phone: '+34 600 333 444',
        hp: '',
        acceptsTerms: true,
        acceptsMarketing: false,
      })
      .expect(201);
    await expect(
      waitForEmail(owner.email, { subjectIncludes: 'Nuevo contacto', timeoutMs: 3000 }),
    ).rejects.toThrow();
  }, 90_000);
});
