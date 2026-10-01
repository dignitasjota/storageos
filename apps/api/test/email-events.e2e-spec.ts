import { createHmac } from 'node:crypto';

import request from 'supertest';

import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const BREVO_TOKEN = process.env.EMAIL_WEBHOOK_TOKEN!;
const RESEND_SECRET = process.env.RESEND_WEBHOOK_SECRET!;

type Comm = {
  id: string;
  status: string;
  providerMessageId: string | null;
  errorMessage: string | null;
};

/**
 * Avisos de entrega de Brevo/Resend: el proveedor acepta un correo y lo
 * rebota o rechaza después; la comunicación debe reflejarlo.
 */
describe('Avisos de entrega del proveedor de correo (e2e)', () => {
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

  /** Emite una factura (sale el aviso «Nueva factura») y devuelve esa comunicación ya enviada. */
  async function sentInvoiceEmail(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `${prefix}-${Date.now()}@e2e.local`,
    });
    const inv = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    let comm: Comm | undefined;
    for (let i = 0; i < 50 && !comm; i++) {
      const res = await request(app.getHttpServer())
        .get(`/communications?invoiceId=${inv}&source=customer_email.invoice_issued`)
        .set(auth);
      comm = (res.body as Comm[]).find((c) => c.status === 'sent' && c.providerMessageId);
      if (!comm) await new Promise((r) => setTimeout(r, 200));
    }
    expect(comm).toBeDefined();
    return { owner, auth, customerId, comm: comm! };
  }

  async function commById(auth: Record<string, string>, id: string): Promise<Comm> {
    const res = await request(app.getHttpServer()).get(`/communications/${id}`).set(auth);
    return res.body as Comm;
  }

  it('Brevo: entregado y luego rebote permanente → bounced + aviso al equipo', async () => {
    const { auth, customerId, comm } = await sentInvoiceEmail('evbrevo');
    const url = `/webhooks/email-events/brevo?token=${BREVO_TOKEN}`;

    await request(app.getHttpServer())
      .post(`/webhooks/email-events/brevo?token=otro`)
      .send({ event: 'delivered', 'message-id': comm.providerMessageId })
      .expect(401);

    await request(app.getHttpServer())
      .post(url)
      .send({ event: 'delivered', 'message-id': comm.providerMessageId, email: 'x@e2e.local' })
      .expect(200);
    expect((await commById(auth, comm.id)).status).toBe('delivered');

    const res = await request(app.getHttpServer())
      .post(url)
      .send({
        event: 'hard_bounce',
        'message-id': comm.providerMessageId,
        email: 'x@e2e.local',
        reason: 'mailbox does not exist',
      })
      .expect(200);
    expect(res.body).toEqual({ matched: 1 });
    const after = await commById(auth, comm.id);
    expect(after.status).toBe('bounced');
    expect(after.errorMessage).toBe('Rebote permanente: mailbox does not exist');

    const notifs = await request(app.getHttpServer()).get('/notifications').set(auth);
    const n = (notifs.body.items as { type: string; link: string | null }[]).find(
      (x) => x.type === 'communication.undelivered',
    );
    expect(n?.link).toBe(`/customers/${customerId}`);
  }, 90_000);

  it('Resend: firma válida aplica el rebote; firma inválida 401', async () => {
    const { auth, comm } = await sentInvoiceEmail('evresend');
    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: new Date().toISOString(),
      data: {
        email_id: comm.providerMessageId,
        to: ['x@e2e.local'],
        bounce: { message: 'No such user' },
      },
    });
    const id = 'msg_e2e_1';
    const ts = Math.floor(Date.now() / 1000);
    const key = Buffer.from(RESEND_SECRET.replace(/^whsec_/, ''), 'base64');
    const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');

    await request(app.getHttpServer())
      .post('/webhooks/email-events/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', String(ts))
      .set('svix-signature', 'v1,ZmFsc2E=')
      .send(body)
      .expect(401);

    await request(app.getHttpServer())
      .post('/webhooks/email-events/resend')
      .set('Content-Type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', String(ts))
      .set('svix-signature', `v1,${sig}`)
      .send(body)
      .expect(200);
    const after = await commById(auth, comm.id);
    expect(after.status).toBe('bounced');
    expect(after.errorMessage).toBe('Rebote: No such user');
  }, 90_000);

  it('rechazo de un correo que no está en Comunicaciones → aviso al super admin (una vez)', async () => {
    const reason = `the sender you used no-reply@e2e-${Date.now()}.test is not valid`;
    const send = () =>
      request(app.getHttpServer())
        .post(`/webhooks/email-events/brevo?token=${BREVO_TOKEN}`)
        .send({ event: 'error', 'message-id': `<desconocido-${Date.now()}@x>`, reason })
        .expect(200);
    await send();
    await send();
    const admin = app.get(PrismaAdminService);
    const rows = await admin.superAdminNotification.findMany({
      where: { type: 'email.provider_rejected', body: { contains: reason } },
    });
    expect(rows).toHaveLength(1);
    await admin.superAdminNotification.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });
});
