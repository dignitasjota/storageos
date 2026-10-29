import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { StubSyncProvider } from '../src/modules/access/providers/stub-sync.provider';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const ADMIN_EMAIL = 'admin-reset-test@storageos.local';

/** Vaciar los datos de prueba de un tenant desde el panel del super admin. */
describe('Admin: vaciar los datos de prueba de un tenant (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Reset Test',
        role: 'superadmin',
      },
    });
    app = await createTestApp();
    const login = await http()
      .post('/admin/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'AdminTest!23' });
    token = login.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.$disconnect();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  it('borra inquilinos, contratos, facturas, cobros y gastos y conserva trasteros, contactos y configuración', async () => {
    const owner = await registerVerifiedUser(app, 'resetok');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const admin = { Authorization: `Bearer ${token}` };

    const customerId = await createCustomer(app, owner.accessToken, { email: 'reset1@e2e.local' });
    const { unitId, facilityId } = await signedContractFor(app, owner.accessToken, {
      id: customerId,
    });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await http()
      .post('/expenses')
      .set(auth)
      .send({ category: 'utilities', description: 'Luz', amount: 80, expenseDate: '2026-10-01' })
      .expect(201);
    await http()
      .post('/leads')
      .set(auth)
      .send({ firstName: 'Lucía', email: 'lucia@e2e.local', source: 'manual' })
      .expect(201);
    expect(
      (await db.invoiceSeries.findFirstOrThrow({ where: { tenantId: owner.tenantId } })).nextNumber,
    ).toBeGreaterThan(1);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('occupied');

    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/reset-preview`)
      .set(admin)
      .expect(200);
    expect(preview.body).toMatchObject({
      tenantSlug: owner.slug,
      counts: { customers: 1, contracts: 1, invoices: 1, payments: 1, expenses: 1 },
      kept: { leads: 1 },
      blockers: [],
    });

    // Confirmación: identificador exacto y haber exportado.
    const wrong = await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin)
      .send({ confirmSlug: 'otro', reason: 'Empezar en real', exported: true });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('confirm_slug_mismatch');
    await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin)
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: false })
      .expect(400);
    await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true })
      .expect(401);

    const done = await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin)
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true })
      .expect(200);
    expect(done.body).toMatchObject({ counts: { customers: 1, invoices: 1 }, unitsFreed: 1 });

    const tenantId = owner.tenantId;
    expect(await db.customer.count({ where: { tenantId } })).toBe(0);
    expect(await db.contract.count({ where: { tenantId } })).toBe(0);
    expect(await db.invoice.count({ where: { tenantId } })).toBe(0);
    expect(await db.payment.count({ where: { tenantId } })).toBe(0);
    expect(await db.expense.count({ where: { tenantId } })).toBe(0);
    // Se conserva lo que no es de los clientes.
    const lead = await db.lead.findFirstOrThrow({ where: { tenantId } });
    expect(lead.email).toBe('lucia@e2e.local');
    expect(await db.facility.count({ where: { id: facilityId } })).toBe(1);
    expect((await db.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe('available');
    expect((await db.invoiceSeries.findFirstOrThrow({ where: { tenantId } })).nextNumber).toBe(1);
    const audit = await db.superAdminAuditLog.findFirst({
      where: { targetTenantId: tenantId, action: 'admin.tenant.operational_data_reset' },
    });
    expect(audit).not.toBeNull();

    // El tenant sigue funcionando: puede dar de alta un inquilino nuevo.
    await http()
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Real',
        lastName: 'Uno',
        email: 'real@e2e.local',
      })
      .expect(201);
  });

  it('no deja vaciar el negocio que emite las facturas de la plataforma', async () => {
    const owner = await registerVerifiedUser(app, 'resetown');
    const admin = { Authorization: `Bearer ${token}` };
    const settings = await db.platformBillingSettings.findFirst();
    const created = !settings;
    const row = settings ?? (await db.platformBillingSettings.create({ data: {} }));
    const previous = row.ownTenantId;
    await db.platformBillingSettings.update({
      where: { id: row.id },
      data: { ownTenantId: owner.tenantId },
    });
    try {
      const preview = await http()
        .get(`/admin/tenants/${owner.tenantId}/reset-preview`)
        .set(admin)
        .expect(200);
      expect(preview.body.blockers[0].code).toBe('platform_own_tenant');
      const res = await http()
        .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
        .set(admin)
        .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('tenant_reset_blocked');
    } finally {
      if (created) await db.platformBillingSettings.delete({ where: { id: row.id } });
      else
        await db.platformBillingSettings.update({
          where: { id: row.id },
          data: { ownTenantId: previous },
        });
    }
  });

  it('quita los accesos de los inquilinos de los terminales antes de borrar', async () => {
    const owner = await registerVerifiedUser(app, 'resetterm');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const admin = { Authorization: `Bearer ${token}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local con terminal',
      unitsCount: 1,
    });
    const dev = await http()
      .post('/access/devices')
      .set(auth)
      .send({
        facilityId,
        type: 'door',
        name: 'Terminal',
        hardwareId: `t-${Date.now()}`,
        provider: 'stub',
      })
      .expect(201);
    const customerId = await createCustomer(app, owner.accessToken, { email: 'term@e2e.local' });
    await signedContractFor(app, owner.accessToken, { id: customerId }, facilityId);
    const cred = await http()
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', allowedFacilityIds: [facilityId], allowedUnitIds: [] })
      .expect(201);
    const stub = app.get(StubSyncProvider);
    expect(stub.stateOf(dev.body.id, cred.body.id)).toBe('active');

    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/reset-preview`)
      .set(admin)
      .expect(200);
    expect(preview.body.warnings.map((w: { code: string }) => w.code)).toContain(
      'synced_credentials',
    );

    await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin)
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true })
      .expect(200);
    expect(stub.stateOf(dev.body.id, cred.body.id)).toBeUndefined();
    expect(await db.accessCredential.count({ where: { tenantId: owner.tenantId } })).toBe(0);
    // El terminal se conserva.
    expect(await db.accessDevice.count({ where: { id: dev.body.id } })).toBe(1);
  });

  it('no deja borrar facturas emitidas en Holded', async () => {
    const owner = await registerVerifiedUser(app, 'resetholded');
    const admin = { Authorization: `Bearer ${token}` };
    const customerId = await createCustomer(app, owner.accessToken, { email: 'hold@e2e.local' });
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await db.invoice.update({ where: { id: invoiceId }, data: { issuedBy: 'holded' } });
    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/reset-preview`)
      .set(admin)
      .expect(200);
    expect(preview.body.blockers.map((b: { code: string }) => b.code)).toContain(
      'holded_issued_invoices',
    );
    const res = await http()
      .post(`/admin/tenants/${owner.tenantId}/reset-operational-data`)
      .set(admin)
      .send({ confirmSlug: owner.slug, reason: 'Empezar en real', exported: true });
    expect(res.status).toBe(409);
    expect(await db.invoice.count({ where: { id: invoiceId } })).toBe(1);
  });
});
