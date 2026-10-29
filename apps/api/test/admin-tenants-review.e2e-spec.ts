import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ADMIN_EMAIL = 'admin-tenants-review@storageos.local';

/** Arreglos de la revisión del apartado Tenants del panel admin. */
describe('Admin: revisión del apartado Tenants (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let token: string;
  const http = () => request(app.getHttpServer());
  const admin = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await db.superAdmin.deleteMany({ where: { email: ADMIN_EMAIL } });
    await db.superAdmin.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: await argonHash('AdminTest!23'),
        fullName: 'Admin Revisión',
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
  });

  /** Deja el tenant activo (o suspendido) en el plan Free, como una prueba ya vencida. */
  async function toFree(tenantId: string, status: 'active' | 'suspended') {
    const free = await db.subscriptionPlan.findFirstOrThrow({ where: { slug: 'free' } });
    await db.tenant.update({
      where: { id: tenantId },
      data: {
        status,
        trialEndsAt: null,
        ...(status === 'suspended' ? { churnReason: 'nonpayment', canceledAt: new Date() } : {}),
      },
    });
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { planId: free.id, status: 'active' },
    });
  }

  it('ampliar la prueba en bloque solo toca a los que están en prueba', async () => {
    const trial = await registerVerifiedUser(app, 'revtrial');
    const activeFree = await registerVerifiedUser(app, 'revfree');
    const suspended = await registerVerifiedUser(app, 'revsusp');
    await toFree(activeFree.tenantId, 'active');
    await toFree(suspended.tenantId, 'suspended');

    const res = await http()
      .post('/admin/tenants/extend-trials')
      .set(admin())
      .send({ tenantIds: [trial.tenantId, activeFree.tenantId, suspended.tenantId], days: 7 })
      .expect(200);
    expect(res.body.updated).toBe(1);
    const [a, b] = await Promise.all([
      db.tenant.findUniqueOrThrow({ where: { id: activeFree.tenantId } }),
      db.tenant.findUniqueOrThrow({ where: { id: suspended.tenantId } }),
    ]);
    expect(a.status).toBe('active');
    expect(b.status).toBe('suspended');

    // Uno a uno, un suspendido no sale de la suspensión por ampliarle la prueba.
    const one = await http()
      .post(`/admin/tenants/${suspended.tenantId}/extend-trial`)
      .set(admin())
      .send({ days: 7, reason: 'Probar de nuevo' });
    expect(one.status).toBe(400);
    expect(one.body.code).toBe('tenant_suspended');
  });

  it('anonimizar el tenant borra también accesos, mensajes y secretos del negocio', async () => {
    const owner = await registerVerifiedUser(app, 'revanon');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken, { email: 'anon@e2e.local' });
    await signedContractFor(app, owner.accessToken, { id: customerId });
    await http()
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', allowedFacilityIds: [], allowedUnitIds: [] })
      .expect(201);
    await http()
      .post(`/customers/${customerId}/messages`)
      .set(auth)
      .send({ body: 'Hola, soy Ana García' })
      .expect(201);
    await db.owner.create({
      data: {
        tenantId: owner.tenantId,
        legalName: 'Propietario SL',
        taxId: 'B12345674',
        email: 'prop@e2e.local',
        phone: '600000000',
        ibanLast4: '1234',
      },
    });
    await db.redsysSettings.create({
      data: { tenantId: owner.tenantId, merchantCode: '999008881', secretKeyEncrypted: 'x' },
    });
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { contactEmail: 'hola@e2e.local', contactPhone: '911111111' },
    });

    await http()
      .post(`/admin/tenants/${owner.tenantId}/anonymize`)
      .set(admin())
      .send({ reason: 'Baja y derecho al olvido' })
      .expect(200);

    const tenantId = owner.tenantId;
    const [creds, messages, owners, redsys, tenant] = await Promise.all([
      db.accessCredential.findMany({ where: { tenantId } }),
      db.customerMessage.findMany({ where: { tenantId } }),
      db.owner.findMany({ where: { tenantId } }),
      db.redsysSettings.count({ where: { tenantId } }),
      db.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    ]);
    expect(creds.length).toBeGreaterThan(0);
    expect(creds.every((c) => c.status === 'revoked' && !c.secretEncrypted)).toBe(true);
    expect(messages.every((m) => m.body === '*** ANONIMIZADO ***')).toBe(true);
    expect(owners[0]).toMatchObject({ legalName: 'Propietario SL', email: null, phone: null });
    expect(redsys).toBe(0);
    expect(tenant).toMatchObject({ contactEmail: null, contactPhone: null, status: 'cancelled' });
  });

  it('valida la zona horaria, el plan de la vista previa y el estado de la lista', async () => {
    const owner = await registerVerifiedUser(app, 'revvalid');
    const tz = await http()
      .patch(`/admin/tenants/${owner.tenantId}`)
      .set(admin())
      .send({ timezone: 'Europa/Madrí' });
    expect(tz.status).toBe(400);
    await http()
      .patch(`/admin/tenants/${owner.tenantId}`)
      .set(admin())
      .send({ timezone: 'Atlantic/Canary' })
      .expect(200);

    const preview = await http()
      .get(`/admin/tenants/${owner.tenantId}/change-plan-preview`)
      .set(admin());
    expect(preview.status).toBe(400);
    expect(preview.body.code).toBe('plan_required');

    const list = await http().get('/admin/tenants?status=raro').set(admin());
    expect(list.status).toBe(400);
    expect(list.body.code).toBe('invalid_status');
  });

  it('el historial nombra el vaciado y enseña los pagos por su fecha', async () => {
    const owner = await registerVerifiedUser(app, 'revtimeline');
    await db.superAdminAuditLog.create({
      data: {
        superAdminId: (await db.superAdmin.findFirstOrThrow({ where: { email: ADMIN_EMAIL } })).id,
        action: 'admin.tenant.operational_data_reset',
        targetType: 'tenant',
        targetId: owner.tenantId,
        targetTenantId: owner.tenantId,
        changes: { reason: 'Empezar en real' },
      },
    });
    // Pago registrado hoy con fecha de hace 60 días: sale por su fecha.
    const old = new Date(Date.now() - 60 * 86_400_000);
    await db.tenantSubscriptionPayment.create({
      data: {
        tenantId: owner.tenantId,
        provider: 'bank_transfer',
        status: 'paid',
        amount: 79,
        currency: 'EUR',
        paidAt: old,
      },
    });
    const page = await http()
      .get(`/admin/tenants/${owner.tenantId}/timeline?kinds=admin_action,payment`)
      .set(admin())
      .expect(200);
    const titles = (page.body.items as { title: string; at: string; kind: string }[]).map(
      (i) => i.title,
    );
    expect(titles).toContain('Datos de prueba vaciados');
    const payment = (page.body.items as { kind: string; at: string }[]).find(
      (i) => i.kind === 'payment',
    );
    expect(new Date(payment!.at).getTime()).toBe(old.getTime());
    // Pidiendo lo anterior a ayer sigue saliendo (antes se filtraba por la fecha de alta).
    const before = new Date(Date.now() - 86_400_000).toISOString();
    const older = await http()
      .get(`/admin/tenants/${owner.tenantId}/timeline?kinds=payment&before=${before}`)
      .set(admin())
      .expect(200);
    expect(older.body.items).toHaveLength(1);
  });
});
