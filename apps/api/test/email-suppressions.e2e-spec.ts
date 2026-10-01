import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupSuperAdmins, seedSuperAdmin } from './helpers/super-admin';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const BREVO_TOKEN = process.env.EMAIL_WEBHOOK_TOKEN!;

type Comm = {
  id: string;
  status: string;
  providerMessageId: string | null;
  errorMessage: string | null;
};

/**
 * Lista de supresión: un rebote permanente bloquea la dirección (los correos
 * siguientes se omiten) y una queja de spam da de baja comercial al inquilino
 * sin cortar sus correos necesarios.
 */
describe('Lista de supresión de correo (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await cleanupSuperAdmins();
    await deleteAllMessages();
  });

  /** Emite una factura y espera a su aviso «Nueva factura» en un estado final. */
  async function issueAndWait(
    auth: Record<string, string>,
    token: string,
    customerId: string,
  ): Promise<Comm> {
    const inv = await createDraftInvoice(app, token, customerId);
    await request(app.getHttpServer()).post(`/invoices/${inv}/issue`).set(auth).expect(200);
    // Hasta 30 s: con varias suites a la vez el outbox puede tardar.
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer())
        .get(`/communications?invoiceId=${inv}&source=customer_email.invoice_issued`)
        .set(auth);
      const comm = (res.body as Comm[])[0];
      if (comm && ['sent', 'skipped', 'failed'].includes(comm.status)) return comm;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('el aviso de la factura no llegó a un estado final');
  }

  async function setup(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `${prefix}-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    return { owner, auth, email, customerId };
  }

  it('rebote permanente → la dirección queda bloqueada y se puede desbloquear', async () => {
    const { owner, auth, email, customerId } = await setup('supbounce');
    const first = await issueAndWait(auth, owner.accessToken, customerId);
    expect(first.status).toBe('sent');

    await request(app.getHttpServer())
      .post(`/webhooks/email-events/brevo?token=${BREVO_TOKEN}`)
      .send({
        event: 'hard_bounce',
        'message-id': first.providerMessageId,
        email,
        reason: 'mailbox does not exist',
      })
      .expect(200);

    const status = await request(app.getHttpServer())
      .get(`/customers/${customerId}/email-status`)
      .set(auth)
      .expect(200);
    expect(status.body).toHaveLength(1);
    expect(status.body[0]).toMatchObject({ scope: 'all', reason: 'hard_bounce', tenantId: null });

    // El siguiente correo no se envía: queda omitido con el motivo.
    const second = await issueAndWait(auth, owner.accessToken, customerId);
    expect(second.status).toBe('skipped');
    expect(second.errorMessage).toContain('bloqueada');

    // El super admin la ve en la lista.
    const sa = await seedSuperAdmin('suppr');
    const login = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: sa.email, password: sa.password })
      .expect(200);
    const adminAuth = { Authorization: `Bearer ${login.body.accessToken}` };
    const list = await request(app.getHttpServer())
      .get(`/admin/email-settings/suppressions?search=${encodeURIComponent(email)}`)
      .set(adminAuth)
      .expect(200);
    expect(list.body.items).toHaveLength(1);

    // El staff lo desbloquea desde la ficha y vuelve a salir.
    const cleared = await request(app.getHttpServer())
      .post(`/customers/${customerId}/email-status/clear`)
      .set(auth)
      .expect(200);
    expect(cleared.body.removed).toBe(1);
    const third = await issueAndWait(auth, owner.accessToken, customerId);
    expect(third.status).toBe('sent');
  }, 60_000);

  it('queja de spam → baja comercial, pero los correos necesarios siguen saliendo', async () => {
    const { owner, auth, email, customerId } = await setup('supspam');
    const first = await issueAndWait(auth, owner.accessToken, customerId);
    expect(first.status).toBe('sent');

    await request(app.getHttpServer())
      .post(`/webhooks/email-events/brevo?token=${BREVO_TOKEN}`)
      .send({ event: 'spam', 'message-id': first.providerMessageId, email })
      .expect(200);

    const customer = await request(app.getHttpServer())
      .get(`/customers/${customerId}`)
      .set(auth)
      .expect(200);
    expect(customer.body.marketingOptOutAt).toBeTruthy();

    const status = await request(app.getHttpServer())
      .get(`/customers/${customerId}/email-status`)
      .set(auth)
      .expect(200);
    expect(status.body[0]).toMatchObject({ scope: 'marketing', reason: 'complaint' });

    const second = await issueAndWait(auth, owner.accessToken, customerId);
    expect(second.status).toBe('sent');
  }, 60_000);
});
