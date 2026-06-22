import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Campaigns segmentadas (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('segmenta clientes/leads, previsualiza y envía al outbox', async () => {
    const owner = await registerVerifiedUser(app, 'campaigns');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    // 2 clientes (uno con tag 'vip'), 1 lead.
    await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Vip',
        lastName: 'Uno',
        email: 'vip@e2e.local',
        country: 'ES',
        tags: ['vip'],
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Normal',
        lastName: 'Dos',
        email: 'normal@e2e.local',
        country: 'ES',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Lead', lastName: 'Tres', email: 'lead@e2e.local' })
      .expect(201);

    // Preview por tag → 1.
    const previewTag = await request(app.getHttpServer())
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', tag: 'vip' } });
    expect(previewTag.status).toBe(200);
    expect(previewTag.body.audienceCount).toBe(1);

    // Preview sin contrato activo → 2 (ninguno tiene contrato).
    const previewNone = await request(app.getHttpServer())
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'customers', contractStatus: 'none' } });
    expect(previewNone.body.audienceCount).toBe(2);

    // Preview leads new → 1.
    const previewLeads = await request(app.getHttpServer())
      .post('/campaigns/preview')
      .set(auth)
      .send({ segment: { audience: 'leads', leadStatus: 'new' } });
    expect(previewLeads.body.audienceCount).toBe(1);

    // Crear campaña (tag vip, cuerpo con variable).
    const create = await request(app.getHttpServer())
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Promo VIP',
        subject: 'Hola {{customer.firstName}}',
        bodyText: 'Hola {{customer.firstName}}, oferta exclusiva para ti.',
        segment: { audience: 'customers', tag: 'vip' },
      });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('draft');
    expect(create.body.audienceCount).toBe(1);
    const id = create.body.id as string;

    // Enviar.
    const send = await request(app.getHttpServer()).post(`/campaigns/${id}/send`).set(auth);
    expect(send.status).toBe(200);
    expect(send.body.status).toBe('sent');
    expect(send.body.sentCount).toBe(1);

    // El envío llegó al outbox con el subject renderizado.
    const comms = await request(app.getHttpServer())
      .get(`/communications?source=campaign:${id}`)
      .set(auth);
    expect(comms.status).toBe(200);
    expect(comms.body).toHaveLength(1);
    expect(comms.body[0].recipient).toBe('vip@e2e.local');
    expect(comms.body[0].subject).toBe('Hola Vip');

    // Reenviar → 409.
    const resend = await request(app.getHttpServer()).post(`/campaigns/${id}/send`).set(auth);
    expect(resend.status).toBe(409);
    expect(resend.body.code).toBe('campaign_not_sendable');
  });
});
