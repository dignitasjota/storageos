import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Invita a un usuario con el rol dado en el tenant del owner, acepta la invitación
 *  y devuelve su access token. */
async function inviteAndAccept(
  app: INestApplication,
  ownerToken: string,
  role: 'manager' | 'staff' | 'readonly',
): Promise<string> {
  const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const inv = await request(app.getHttpServer())
    .post('/invitations')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status}: ${JSON.stringify(inv.body)}`);
  const mail = await waitForEmail(inv.body.email, { subjectIncludes: 'invitado' });
  const token = extractToken(mail.Text, '/invite');
  const accept = await request(app.getHttpServer())
    .post(`/invitations/token/${token}/accept`)
    .send({ fullName: role, password: 'Passw0rd!' });
  if (accept.status !== 200)
    throw new Error(`accept failed ${accept.status}: ${JSON.stringify(accept.body)}`);
  return accept.body.accessToken as string;
}

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Recordatorio de pago en lote: el staff envía desde la lista de facturas un
 * aviso puntual a N facturas pendientes (issued/overdue). Distinto del dunning
 * automático; reutiliza la plantilla `invoice_overdue_email`.
 */
describe('Recordatorios de pago en lote (e2e)', () => {
  let app: INestApplication;
  let adminClient: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    adminClient = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await adminClient.$disconnect();
    await cleanupTestTenants();
  });

  it('bulk/remind encola el recordatorio de las pendientes y reporta las no pendientes', async () => {
    const owner = await registerVerifiedUser(app, 'bulk-remind');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);

    // Una factura emitida (pendiente → recordable) y un borrador (no recordable).
    const issued = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 50 });
    await request(app.getHttpServer()).post(`/invoices/${issued}/issue`).set(auth).expect(200);
    const draft = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 60 });

    const res = await request(app.getHttpServer())
      .post('/invoices/bulk/remind')
      .set(auth)
      .send({ ids: [issued, draft] });

    expect(res.status).toBe(200);
    expect(res.body.succeeded).toContain(issued);
    const failed = (res.body.failed as { id: string; error: string }[]).find((f) => f.id === draft);
    expect(failed?.error).toBe('invoice_not_pending');

    // Se encoló exactamente un recordatorio manual (email) para la factura emitida.
    const comms = await adminClient.communication.findMany({
      where: { customerId, source: 'bulk.manual_reminder' },
    });
    expect(comms.length).toBe(1);
    expect(comms[0]?.channel).toBe('email');
  });

  it('bulk/remind sin permiso communications:send responde 403 (readonly)', async () => {
    const owner = await registerVerifiedUser(app, 'bulk-remind-perm');
    const readonlyToken = await inviteAndAccept(app, owner.accessToken, 'readonly');
    const customerId = await createCustomer(app, owner.accessToken);
    const issued = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 40 });
    await request(app.getHttpServer())
      .post(`/invoices/${issued}/issue`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(200);

    // El guard rechaza antes de tocar el servicio.
    await request(app.getHttpServer())
      .post('/invoices/bulk/remind')
      .set({ Authorization: `Bearer ${readonlyToken}` })
      .send({ ids: [issued] })
      .expect(403);
  });
});
