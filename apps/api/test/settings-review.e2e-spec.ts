import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { WebhooksDispatcherService } from '../src/modules/integrations/webhooks-dispatcher.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Revisión de Configuración: invitaciones, propietario, negocio, RGPD, series y webhooks. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Revisión de Configuración (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  it('una invitación caducada no bloquea volver a invitar', async () => {
    const owner = await registerVerifiedUser(app, 'setrev1');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `caducada-${Date.now()}@e2e.local`;
    const first = await http().post('/invitations').set(auth).send({ email, role: 'staff' });
    expect(first.status).toBe(201);
    await db.invitation.update({
      where: { id: first.body.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const list = await http().get('/invitations').set(auth).expect(200);
    expect(list.body.find((i: { id: string }) => i.id === first.body.id)?.status).toBe('expired');

    const again = await http().post('/invitations').set(auth).send({ email, role: 'staff' });
    expect(again.status).toBe(201);
    const old = await db.invitation.findUnique({ where: { id: first.body.id } });
    expect(old?.revokedReason).toBe('expired');
  });

  it('el propietario no se puede limitar con un rol ni con locales', async () => {
    const owner = await registerVerifiedUser(app, 'setrev2');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const role = await http()
      .post('/settings/roles')
      .set(auth)
      .send({ name: 'Mínimo', permissions: ['invoices:read'], baseRole: 'readonly' })
      .expect(201);

    const assign = await http()
      .patch(`/settings/users/${owner.userId}/tenant-role`)
      .set(auth)
      .send({ tenantRoleId: role.body.id });
    expect(assign.status).toBe(400);
    expect(assign.body.code).toBe('owner_full_access');

    const fac = await http()
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local', address: 'Calle 1', city: 'Madrid', postalCode: '28001' });
    const facilities = await http()
      .patch(`/settings/users/${owner.userId}/facilities`)
      .set(auth)
      .send({ facilityIds: [fac.body.id] });
    expect(facilities.status).toBe(400);
    expect(facilities.body.code).toBe('owner_full_access');
  });

  it('el negocio cambia su nombre y su zona horaria', async () => {
    const owner = await registerVerifiedUser(app, 'setrev3');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const res = await http()
      .patch('/settings/tenant/profile')
      .set(auth)
      .send({ name: 'Trasteros Canarios', timezone: 'Atlantic/Canary' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Trasteros Canarios', timezone: 'Atlantic/Canary' });
    const me = await http().get('/auth/me').set(auth).expect(200);
    expect(me.body.tenant.name).toBe('Trasteros Canarios');

    const bad = await http()
      .patch('/settings/tenant/profile')
      .set(auth)
      .send({ timezone: 'Marte/Olympus' });
    expect(bad.status).toBe(400);
  });

  it('una solicitud de protección de datos se puede cerrar', async () => {
    const owner = await registerVerifiedUser(app, 'setrev4');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const created = await http()
      .post('/rgpd/requests')
      .set(auth)
      .send({ email: 'ana@e2e.local', requestType: 'access' })
      .expect(201);
    const done = await http()
      .patch(`/rgpd/requests/${created.body.id}`)
      .set(auth)
      .send({ status: 'fulfilled', notes: 'Enviado por correo' })
      .expect(200);
    expect(done.body.status).toBe('fulfilled');
    expect(done.body.fulfilledAt).not.toBeNull();
    expect(done.body.notes).toBe('Enviado por correo');
  });

  it('las series protegen su numeración y la serie por defecto', async () => {
    const owner = await registerVerifiedUser(app, 'setrev5');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const series = await http().get('/invoice-series').set(auth).expect(200);
    const main = series.body.find((s: { isDefault: boolean }) => s.isDefault);

    const noDefault = await http()
      .patch(`/invoice-series/${main.id}`)
      .set(auth)
      .send({ isActive: false });
    expect(noDefault.status).toBe(409);
    expect(noDefault.body.code).toBe('default_series_required');

    await db.invoice.create({
      data: {
        tenantId: owner.tenantId,
        seriesId: main.id,
        invoiceNumber: `${main.prefix}-TEST-1`,
        sequenceNumber: 1,
        status: 'issued',
        issueDate: new Date(),
        subtotal: 10,
        taxAmount: 0,
        total: 10,
      },
    });
    const prefix = await http()
      .patch(`/invoice-series/${main.id}`)
      .set(auth)
      .send({ prefix: 'ZZ' });
    expect(prefix.status).toBe(409);
    expect(prefix.body.code).toBe('series_in_use');
    // El nombre sí se puede cambiar.
    await http()
      .patch(`/invoice-series/${main.id}`)
      .set(auth)
      .send({ name: 'Principal' })
      .expect(200);
  });

  it('el webhook suscrito al nombre antiguo sigue recibiendo la factura emitida', async () => {
    const owner = await registerVerifiedUser(app, 'setrev6');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const legacy = await http()
      .post('/settings/webhooks')
      .set(auth)
      .send({ name: 'Antiguo', url: 'https://example.test/old', events: ['invoice.created'] })
      .expect(201);
    const current = await http()
      .post('/settings/webhooks')
      .set(auth)
      .send({ name: 'Nuevo', url: 'https://example.test/new', events: ['invoice.issued'] })
      .expect(201);

    await app.get(WebhooksDispatcherService).onInvoiceIssued({
      tenantId: owner.tenantId,
      entityType: 'invoice',
      entityId: '00000000-0000-7000-8000-000000000001',
      scope: {},
    } as never);

    const deliveries = await db.webhookDelivery.findMany({
      where: { tenantId: owner.tenantId },
      select: { webhookId: true, eventType: true },
    });
    expect(deliveries).toEqual(
      expect.arrayContaining([
        { webhookId: legacy.body.id ?? legacy.body.webhook?.id, eventType: 'invoice.created' },
        { webhookId: current.body.id ?? current.body.webhook?.id, eventType: 'invoice.issued' },
      ]),
    );
    expect(deliveries).toHaveLength(2);
  });
});
