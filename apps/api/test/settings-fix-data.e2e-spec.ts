import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { FilesService } from '../src/modules/files/files.service';
import { WebhooksProcessor } from '../src/modules/integrations/webhooks.processor';
import { JOB_WEBHOOK_DELIVER } from '../src/modules/queues/queues.module';

import { registerVerifiedUser, type VerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const ANON = '*** ANONIMIZADO ***';

/**
 * Configuración: registro de actividad, protección de datos, integraciones y
 * «Conviene revisar» (revisión de la parte de datos e integraciones).
 */
describe('Configuración: datos e integraciones (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());
  const bearer = (u: VerifiedUser) => ({ Authorization: `Bearer ${u.accessToken}` });

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('el registro de actividad no enseña lo interno de la plataforma ni el ruido', async () => {
    const owner = await registerVerifiedUser(app, 'cfgaudit');
    const tenantId = owner.tenantId;
    const superAdminId = '00000000-0000-4000-8000-000000000001';
    await db.auditLog.createMany({
      data: [
        {
          tenantId,
          action: 'admin.tenant.suspended',
          entityType: 'Tenant',
          entityId: tenantId,
          changes: { reason: 'Impago', superAdminId },
          ipAddress: '10.0.0.1',
        },
        {
          tenantId,
          action: 'support_ticket.internal_note_added',
          entityType: 'SupportTicket',
          changes: { messageId: 'x', superAdminId },
        },
        {
          tenantId,
          action: 'support_ticket.transitioned',
          entityType: 'SupportTicket',
          changes: { from: 'open', to: 'resolved', superAdminId, reason: 'interno' },
          ipAddress: '10.0.0.2',
        },
        { tenantId, userId: owner.userId, action: 'auth.refresh', entityType: 'Session' },
      ],
    });

    const res = await http().get('/audit-logs').set(bearer(owner)).expect(200);
    const actions = (res.body.items as { action: string }[]).map((i) => i.action);
    expect(actions).not.toContain('admin.tenant.suspended');
    expect(actions).not.toContain('support_ticket.internal_note_added');
    expect(actions).not.toContain('auth.refresh');
    const transitioned = (
      res.body.items as {
        action: string;
        changes: Record<string, unknown>;
        ipAddress: string | null;
        userName: string | null;
      }[]
    ).find((i) => i.action === 'support_ticket.transitioned')!;
    expect(transitioned.changes).toEqual({ from: 'open', to: 'resolved' });
    expect(transitioned.ipAddress).toBeNull();
    expect(transitioned.userName).toBe('Soporte de TrasterOS');

    // Filtrando por «auth» sí salen las renovaciones de sesión.
    const auth = await http().get('/audit-logs?action=auth.').set(bearer(owner)).expect(200);
    expect((auth.body.items as { action: string }[]).map((i) => i.action)).toContain(
      'auth.refresh',
    );
    // Ni filtrando a propósito se ve lo del super admin.
    const admin = await http().get('/audit-logs?action=admin.').set(bearer(owner)).expect(200);
    expect(admin.body.items).toHaveLength(0);
  });

  it('«Conviene revisar» no avisa de páginas que el usuario no puede abrir', async () => {
    const owner = await registerVerifiedUser(app, 'cfghealth');
    const ownerItems = await http().get('/settings/tenant/health').set(bearer(owner)).expect(200);
    const ownerKeys = (ownerItems.body as { key: string }[]).map((i) => i.key);
    // Un negocio recién dado de alta no tiene datos fiscales.
    expect(ownerKeys).toContain('company_data');

    const manager = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [],
      tag: 'cfghealth-mgr',
    });
    const managerItems = await http().get('/settings/tenant/health').set(manager).expect(200);
    const managerHrefs = (managerItems.body as { href: string }[]).map((i) => i.href);
    // Datos de la empresa y cobros piden `billing:configure` (solo el propietario).
    expect(managerHrefs).not.toContain('/settings/company');
    expect(managerHrefs).not.toContain('/settings/payments');
  });

  it('anonimizar comprueba reservas y deuda, cancela borradores y borra documentos', async () => {
    const owner = await registerVerifiedUser(app, 'cfgrgpd');
    const auth = bearer(owner);
    const tenantId = owner.tenantId;
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `rgpd-fix-${Date.now()}@e2e.local`,
    });
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });

    // 1) Con una reserva en curso → 409.
    const reservation = await db.reservation.create({
      data: {
        tenantId,
        unitId: unitIds[0]!,
        customerId,
        status: 'confirmed',
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    const withReservation = await http()
      .post(`/rgpd/customers/${customerId}/anonymize`)
      .set(auth)
      .expect(409);
    expect(withReservation.body.code).toBe('customer_has_reservations');
    await db.reservation.update({
      where: { id: reservation.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    // 2) Con deuda → 409 salvo confirmación.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const withDebt = await http()
      .post(`/rgpd/customers/${customerId}/anonymize`)
      .set(auth)
      .expect(409);
    expect(withDebt.body.code).toBe('customer_has_debt');
    expect(withDebt.body.details.amount).toBeGreaterThan(0);

    // 3) Borrador de contrato: se cancela al anonimizar.
    const draft = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[1], startDate: '2026-01-01', priceMonthly: 50 })
      .expect(201);

    // 4) Un documento con su fichero en el almacén.
    const files = app.get(FilesService);
    const key = `${tenantId}/customers/${customerId}/dni-${Date.now()}.pdf`;
    await db.customerDocument.create({
      data: {
        tenantId,
        customerId,
        type: 'id_front',
        fileUrl: files.buildPublicUrl('uploads', key),
        fileName: 'dni.pdf',
        mimeType: 'application/pdf',
        fileSize: 10,
      },
    });
    const deleteSpy = jest.spyOn(files, 'deleteObjects');

    // 5) Una solicitud de otra persona no vale para anonimizarlo.
    const other = await http()
      .post('/rgpd/requests')
      .set(auth)
      .send({ email: 'otra-persona@e2e.local', requestType: 'erasure' })
      .expect(201);
    const mismatch = await http()
      .post(`/rgpd/customers/${customerId}/anonymize?requestId=${other.body.id}&confirmDebt=1`)
      .set(auth)
      .expect(400);
    expect(mismatch.body.code).toBe('request_customer_mismatch');
    await http()
      .post(`/rgpd/customers/${customerId}/anonymize?requestId=no-es-un-id&confirmDebt=1`)
      .set(auth)
      .expect(400);

    await http()
      .post(`/rgpd/customers/${customerId}/anonymize?confirmDebt=1`)
      .set(auth)
      .expect(204);

    const contract = await db.contract.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(contract.status).toBe('cancelled');
    expect(await db.customerDocument.count({ where: { customerId } })).toBe(0);
    const deleted = deleteSpy.mock.calls.flatMap((c) => c[1] as string[]);
    expect(deleted).toContain(key);
    deleteSpy.mockRestore();
  });

  it('anonimizar a quien no tiene email limpia su contacto por teléfono y sus incidencias del portal', async () => {
    const owner = await registerVerifiedUser(app, 'cfgrgpdph');
    const auth = bearer(owner);
    const tenantId = owner.tenantId;
    const phone = `6${String(Date.now()).slice(-8)}`;
    const created = await http()
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Pepe', lastName: 'Sin Email', phone })
      .expect(201);
    const customerId = created.body.id as string;
    const lead = await db.lead.create({
      data: { tenantId, source: 'web', firstName: 'Pepe', phone, message: 'Quiero un trastero' },
    });
    const portalIncident = await db.incident.create({
      data: {
        tenantId,
        customerId,
        title: 'Mi puerta no abre, soy Pepe',
        description: 'Llamadme al 600',
        reportedByExternal: 'Portal: Pepe Sin Email',
      },
    });
    const staffIncident = await db.incident.create({
      data: {
        tenantId,
        customerId,
        title: 'Gotera en el pasillo',
        reportedByUserId: owner.userId,
        reportedByExternal: 'Pepe Sin Email',
      },
    });

    await http().post(`/rgpd/customers/${customerId}/anonymize`).set(auth).expect(204);

    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(l.firstName).toBe(ANON);
    expect(l.phone).toBeNull();
    const p = await db.incident.findUniqueOrThrow({ where: { id: portalIncident.id } });
    expect(p).toMatchObject({ title: ANON, description: ANON, reportedByExternal: 'Portal' });
    const s = await db.incident.findUniqueOrThrow({ where: { id: staffIncident.id } });
    expect(s).toMatchObject({ title: 'Gotera en el pasillo', reportedByExternal: null });
  });

  it('la exportación de un inquilino no lleva secretos y queda en el registro', async () => {
    const owner = await registerVerifiedUser(app, 'cfgrgpdexp');
    const auth = bearer(owner);
    const tenantId = owner.tenantId;
    const customerId = await createCustomer(app, owner.accessToken);
    await db.customer.update({
      where: { id: customerId },
      data: { portalPasswordHash: '$argon2id$secreto' },
    });
    await db.customerMessage.create({
      data: { tenantId, customerId, senderType: 'customer', body: 'Hola' },
    });
    await db.customerMessage.create({
      data: { tenantId, customerId, senderType: 'staff', body: 'Nota interna', isInternal: true },
    });
    await db.sepaMandate.create({
      data: {
        tenantId,
        customerId,
        reference: `MND-${Date.now()}`,
        ibanEncrypted: 'cifrado',
        ibanLast4: '1332',
        signedAt: new Date(),
        sequenceType: 'FRST',
        status: 'active',
        signatureStatus: 'signed',
      },
    });

    const res = await http().get(`/rgpd/customers/${customerId}/export`).set(auth).expect(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('portalPasswordHash');
    expect(text).not.toContain('ibanEncrypted');
    expect(text).not.toContain('Nota interna');
    expect(res.body.chatMessages).toHaveLength(1);
    expect(res.body.sepaMandates[0].iban).toMatch(/1332$/);
    expect(Array.isArray(res.body.communications)).toBe(true);
    expect(Array.isArray(res.body.accessCredentials)).toBe(true);
    expect(Array.isArray(res.body.incidents)).toBe(true);

    const log = await db.auditLog.findFirst({
      where: { tenantId, action: 'rgpd.customer_exported', entityId: customerId },
    });
    expect(log).not.toBeNull();
  });

  it('el plazo de una solicitud es de un mes natural', async () => {
    const owner = await registerVerifiedUser(app, 'cfgrgpddue');
    const res = await http()
      .post('/rgpd/requests')
      .set(bearer(owner))
      .send({ email: 'alguien@e2e.local', requestType: 'access' })
      .expect(201);
    const submitted = new Date(res.body.submittedAt as string);
    const due = new Date(res.body.dueAt as string);
    const months =
      (due.getUTCFullYear() - submitted.getUTCFullYear()) * 12 +
      (due.getUTCMonth() - submitted.getUTCMonth());
    expect(months).toBe(1);
  });

  it('claves de API: hace falta un permiso y el token lleva su id', async () => {
    const owner = await registerVerifiedUser(app, 'cfgapikey');
    const auth = bearer(owner);
    const empty = await http()
      .post('/settings/api-keys')
      .set(auth)
      .send({ name: 'Sin permisos', scopes: [] })
      .expect(400);
    expect(empty.body.code).toBe('scope_required');

    const created = await http()
      .post('/settings/api-keys')
      .set(auth)
      .send({ name: 'Lectura', scopes: ['invoices:read'] })
      .expect(201);
    const token = created.body.keyPlaintext as string;
    expect(token).toContain(`.${(created.body.id as string).replace(/-/g, '')}_`);
    await http().get('/integrations/whoami').set('Authorization', `Bearer ${token}`).expect(200);
    // Mismo id con otro secreto: no entra.
    const forged = token.replace(/_[^_]+$/, '_secretoinventado1234567890');
    await http().get('/integrations/whoami').set('Authorization', `Bearer ${forged}`).expect(401);

    // Las claves antiguas (`sk_live_<tenant>.<secreto>`) siguen valiendo.
    const legacySecret = 'claveantigua-1234567890abcdef';
    await db.apiKey.create({
      data: {
        tenantId: owner.tenantId,
        name: 'Antigua',
        keyPrefix: `sk_live_${owner.tenantId}`,
        keyHash: await argonHash(legacySecret),
        scopes: ['*'],
        createdByUserId: owner.userId,
      },
    });
    await http()
      .get('/integrations/whoami')
      .set('Authorization', `Bearer sk_live_${owner.tenantId}.${legacySecret}`)
      .expect(200);
  });

  it('webhooks: no se envía a uno revocado, el reintento es único y «hasta» incluye el día', async () => {
    const owner = await registerVerifiedUser(app, 'cfgwebhook');
    const auth = bearer(owner);
    const hook = await http()
      .post('/settings/webhooks')
      .set(auth)
      .send({ name: 'Mi sistema', url: 'https://example.test/hook', events: ['lead.created'] })
      .expect(201);
    const webhookId = hook.body.id as string;
    const failed = await db.webhookDelivery.create({
      data: {
        tenantId: owner.tenantId,
        webhookId,
        eventType: 'lead.created',
        payload: { type: 'lead.created' },
        signature: 't=1,v1=x',
        status: 'failed',
        attempts: 3,
        scheduledFor: new Date(),
      },
    });

    // «Hasta» con el día de hoy incluye lo de hoy.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
      new Date(),
    );
    const list = await http()
      .get(`/settings/webhooks/${webhookId}/deliveries?fromDate=${today}&toDate=${today}`)
      .set(auth)
      .expect(200);
    expect((list.body.items as { id: string }[]).map((d) => d.id)).toContain(failed.id);

    // Dos reintentos a la vez: solo uno pasa.
    const [a, b] = await Promise.all([
      http().post(`/settings/webhooks/${webhookId}/deliveries/${failed.id}/retry`).set(auth),
      http().post(`/settings/webhooks/${webhookId}/deliveries/${failed.id}/retry`).set(auth),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);

    // Revocado: el reintento se rechaza y el worker no envía nada.
    await http().delete(`/settings/webhooks/${webhookId}`).set(auth).expect(200);
    const pending = await db.webhookDelivery.create({
      data: {
        tenantId: owner.tenantId,
        webhookId,
        eventType: 'lead.created',
        payload: { type: 'lead.created' },
        signature: 't=1,v1=x',
        status: 'pending',
        scheduledFor: new Date(),
      },
    });
    await app.get(WebhooksProcessor).process({
      name: JOB_WEBHOOK_DELIVER,
      data: { deliveryId: pending.id, tenantId: owner.tenantId },
      attemptsMade: 0,
    } as unknown as Job<{ deliveryId: string; tenantId: string }>);
    const after = await db.webhookDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.status).toBe('failed');
    expect(after.statusCode).toBeNull();
    await db.webhookDelivery.update({ where: { id: failed.id }, data: { status: 'failed' } });
    const retryRevoked = await http()
      .post(`/settings/webhooks/${webhookId}/deliveries/${failed.id}/retry`)
      .set(auth)
      .expect(400);
    expect(retryRevoked.body.code).toBe('webhook_inactive');
  });
});
