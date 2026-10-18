import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CommunicationsService } from '../src/modules/communications/communications.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { AutoChargeService } from '../src/modules/payments/auto-charge.service';
import { SuspensionHoldsCron } from '../src/modules/suspension-holds/suspension-holds.cron';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Tenant suspendido: no se cobra a sus inquilinos ni se les escribe; las
 * facturas se siguen generando. Al pagar, cobros y correos salen solos.
 */
describe('Tenant suspendido: cobros y correos en espera (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
    return { owner, auth, customerId, invoiceId, tenantId: tenant.id };
  }

  it('retiene los correos y los manda al reactivarse; los de más de 30 días se omiten', async () => {
    const { tenantId } = await setup('susholdmail');
    await admin.tenant.update({ where: { id: tenantId }, data: { status: 'suspended' } });
    const comms = app.get(CommunicationsService);
    const fresh = await comms.enqueue({
      tenantId,
      channel: 'email',
      recipient: 'inquilino@e2e.local',
      templateCode: 'welcome_email',
      trigger: 'customer_created',
      variables: { customer: { firstName: 'Lola' }, tenant: { name: 'Trasteros' } },
      source: 'test.held',
    });
    const old = await comms.enqueue({
      tenantId,
      channel: 'email',
      recipient: 'viejo@e2e.local',
      templateCode: 'welcome_email',
      trigger: 'customer_created',
      variables: { customer: { firstName: 'Paco' }, tenant: { name: 'Trasteros' } },
      source: 'test.held',
    });
    await comms.dispatch(tenantId, fresh.id);
    await comms.dispatch(tenantId, old.id);
    const heldFresh = await admin.communication.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(heldFresh.status).toBe('pending');
    expect(heldFresh.heldAt).not.toBeNull();
    await admin.communication.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) },
    });

    // Sigue suspendido: no sale nada.
    await app.get(SuspensionHoldsCron).run();
    expect(
      (await admin.communication.findUniqueOrThrow({ where: { id: fresh.id } })).heldAt,
    ).not.toBeNull();

    // Paga → sale el reciente y el antiguo se omite.
    await admin.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    const run = await app.get(SuspensionHoldsCron).run();
    expect(run.emails).toBeGreaterThanOrEqual(1);
    expect(run.expired).toBeGreaterThanOrEqual(1);
    const skipped = await admin.communication.findUniqueOrThrow({ where: { id: old.id } });
    expect(skipped.status).toBe('skipped');
    const released = await admin.communication.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(released.heldAt).toBeNull();
    // El job encolado al liberarlo lo envía.
    let sent = '';
    for (let k = 0; k < 50 && sent !== 'sent'; k++) {
      await new Promise((r) => setTimeout(r, 200));
      sent = (await admin.communication.findUniqueOrThrow({ where: { id: fresh.id } })).status;
    }
    expect(sent).toBe('sent');
  });

  it('retiene el cobro automático, muestra lo retenido y para el reloj de impagos', async () => {
    const { auth, invoiceId, tenantId } = await setup('susholdcharge');
    await admin.tenant.update({
      where: { id: tenantId },
      data: { status: 'suspended', autoChargeOnIssue: true },
    });

    const res = await app.get(AutoChargeService).processAutoCharge({ tenantId, invoiceId });
    expect(res).toEqual({ charged: false, reason: 'tenant_suspended' });
    expect(
      (await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).chargeHeldAt,
    ).not.toBeNull();

    const status = await request(app.getHttpServer()).get('/settings/billing-status').set(auth);
    expect(status.body.heldAmount).toBeCloseTo(121, 2);

    const scheduledFor = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const action = await admin.dunningAction.create({
      data: { tenantId, invoiceId, actionType: 'email_reminder', scheduledFor },
    });
    await app.get(DunningService).dailyTick();
    const moved = await admin.dunningAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(moved.scheduledFor.getTime() - scheduledFor.getTime()).toBe(24 * 3600 * 1000);

    await admin.tenant.update({ where: { id: tenantId }, data: { status: 'active' } });
    const run = await app.get(SuspensionHoldsCron).run();
    expect(run.charges).toBeGreaterThanOrEqual(1);
    expect(
      (await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).chargeHeldAt,
    ).toBeNull();
    expect(
      (await request(app.getHttpServer()).get('/settings/billing-status').set(auth)).body
        .heldAmount,
    ).toBe(0);
  });
});
