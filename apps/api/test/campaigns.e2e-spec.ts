import request from 'supertest';

import { CampaignsService } from '../src/modules/campaigns/campaigns.service';
import { CommunicationsService } from '../src/modules/communications/communications.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

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
      .send({
        firstName: 'Lead',
        lastName: 'Tres',
        email: 'lead@e2e.local',
        marketingConsent: true,
      })
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
    // Enviar: responde ya («enviando») y termina en segundo plano.
    const send = await request(app.getHttpServer()).post(`/campaigns/${id}/send`).set(auth);
    expect(send.status).toBe(200);
    expect(['sending', 'sent']).toContain(send.body.status);
    const done = await waitForCampaign(auth, id);
    expect(done.status).toBe('sent');
    expect(done.sentCount).toBe(1);

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

  it('una campaña atascada en «enviando» se retoma sin duplicar envíos', async () => {
    const owner = await registerVerifiedUser(app, 'campresume');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    for (const n of [1, 2]) {
      await request(app.getHttpServer())
        .post('/customers')
        .set(auth)
        .send({
          customerType: 'individual',
          firstName: `Res${n}`,
          lastName: 'Ume',
          email: `resume${n}-${Date.now()}@e2e.local`,
          country: 'ES',
          tags: ['resume'],
        })
        .expect(201);
    }
    const create = await request(app.getHttpServer())
      .post('/campaigns')
      .set(auth)
      .send({
        name: 'Retomada',
        subject: 'Hola',
        bodyText: 'Cuerpo',
        segment: { audience: 'customers', tag: 'resume' },
      })
      .expect(201);
    const id = create.body.id as string;

    // Simula un corte: ya iba «enviando», con un destinatario encolado, y
    // lleva un rato sin avanzar.
    const admin = app.get(PrismaAdminService);
    const tenantId = (await admin.campaign.findUniqueOrThrow({ where: { id } })).tenantId;
    const first = await admin.customer.findFirstOrThrow({
      where: { tenantId, firstName: 'Res1' },
    });
    await app.get(CommunicationsService).enqueue({
      tenantId,
      channel: 'email',
      recipient: first.email!,
      subject: 'Hola',
      bodyText: 'Cuerpo',
      customerId: first.id,
      source: `campaign:${id}`,
      marketing: true,
    });
    await admin.$executeRaw`UPDATE campaigns SET status = 'sending', updated_at = now() - interval '1 hour' WHERE id = ${id}::uuid`;

    expect(await app.get(CampaignsService).resumeStale()).toBeGreaterThanOrEqual(1);
    const done = await waitForCampaign(auth, id);
    expect(done.status).toBe('sent');
    expect(done.sentCount).toBe(2);
    const comms = await request(app.getHttpServer())
      .get(`/communications?source=campaign:${id}`)
      .set(auth);
    expect(comms.body).toHaveLength(2);
  });

  async function waitForCampaign(
    auth: Record<string, string>,
    id: string,
  ): Promise<{ status: string; sentCount: number }> {
    for (let i = 0; i < 50; i++) {
      const res = await request(app.getHttpServer()).get(`/campaigns/${id}`).set(auth);
      if (res.body.status !== 'sending') return res.body;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('la campaña no terminó de enviarse');
  }
});
