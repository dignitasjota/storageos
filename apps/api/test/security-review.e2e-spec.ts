import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  process.env.DATABASE_URL ??
  'postgresql://storageos:storageos@localhost:5432/storageos?schema=public';

async function inviteStaff(
  app: INestApplication,
  ownerToken: string,
): Promise<{ accessToken: string; userId: string }> {
  const email = `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.local`;
  const inv = await request(app.getHttpServer())
    .post('/invitations')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email, role: 'staff' });
  expect(inv.status).toBe(201);
  const mail = await waitForEmail(inv.body.email, { subjectIncludes: 'invitado' });
  const token = extractToken(mail.Text, '/invite');
  const accept = await request(app.getHttpServer())
    .post(`/invitations/token/${token}/accept`)
    .send({ fullName: 'Staff', password: 'Passw0rd!' });
  expect(accept.status).toBe(200);
  return { accessToken: accept.body.accessToken, userId: accept.body.user.id };
}

/** Arreglos de la revisión de seguridad de octubre. */
describe('Revisión de seguridad (e2e)', () => {
  let app: INestApplication;
  const prisma = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await cleanupTestTenants();
  });

  it('no cobra una factura con el método de pago de otro inquilino', async () => {
    const owner = await registerVerifiedUser(app, 'secpm');
    const a = await createCustomer(app, owner.accessToken);
    const b = await createCustomer(app, owner.accessToken);
    const pmB = await prisma.paymentMethod.create({
      data: {
        tenantId: owner.tenantId,
        customerId: b,
        type: 'sepa_debit',
        gateway: 'gocardless',
        gatewayTokenEncrypted: 'x',
        isDefault: true,
      },
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, a);
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/payments/invoices/${invoiceId}/charge`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentMethodId: pmB.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('payment_method_not_for_customer');
    expect(await prisma.payment.count({ where: { invoiceId } })).toBe(0);
  });

  it('el token deja de valer al desactivar al usuario o cambiarle el rol', async () => {
    const owner = await registerVerifiedUser(app, 'secjwt');
    await deleteAllMessages();
    const staff = await inviteStaff(app, owner.accessToken);
    const me = () =>
      request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${staff.accessToken}`);
    expect((await me()).status).toBe(200);

    // Cambio de rol: el token emitido como staff ya no vale.
    await prisma.user.update({ where: { id: staff.userId }, data: { role: 'manager' } });
    const outdated = await me();
    expect(outdated.status).toBe(401);
    expect(outdated.body.code).toBe('session_outdated');

    // Desactivado: tampoco.
    await prisma.user.update({
      where: { id: staff.userId },
      data: { role: 'staff', isActive: false },
    });
    const gone = await me();
    expect(gone.status).toBe(401);
    expect(gone.body.code).toBe('account_unavailable');
  });
});
