import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Responder a un contacto (lead) por email desde el panel. */
describe('Responder a un lead (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('envía el correo, queda en su historial y el lead pasa a contactado', async () => {
    const owner = await registerVerifiedUser(app, 'leadreply');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `lead-reply-${Date.now()}@e2e.local`;
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Marta', email })
      .expect(201);
    expect(lead.body.status).toBe('new');

    const sent = await request(app.getHttpServer())
      .post(`/leads/${lead.body.id}/reply`)
      .set(auth)
      .send({ subject: 'Sobre tu consulta', body: 'Hola Marta, tenemos trasteros de 5 m² libres.' })
      .expect(201);
    expect(sent.body).toMatchObject({
      recipient: email,
      leadId: lead.body.id,
      source: 'lead.reply',
    });

    const mail = await waitForEmail(email, { subjectIncludes: 'Sobre tu consulta' });
    expect(mail.Text).toContain('tenemos trasteros de 5 m² libres');

    const history = await request(app.getHttpServer())
      .get(`/communications?leadId=${lead.body.id}`)
      .set(auth)
      .expect(200);
    expect(history.body).toHaveLength(1);

    const after = await request(app.getHttpServer())
      .get(`/leads/${lead.body.id}`)
      .set(auth)
      .expect(200);
    expect(after.body.status).toBe('contacted');

    // Sin email no se puede responder.
    const noEmail = await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Sin', phone: '600000000' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post(`/leads/${noEmail.body.id}/reply`)
      .set(auth)
      .send({ subject: 'Hola', body: 'Texto' })
      .expect(400);
    expect(res.body.code).toBe('lead_without_email');
  });
});
