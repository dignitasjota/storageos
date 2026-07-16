import request from 'supertest';

import { AccessCredentialsService } from '../src/modules/access/access-credentials.service';
import { DahuaSyncService } from '../src/modules/access/dahua-sync.service';
import { StubSyncProvider } from '../src/modules/access/providers/stub-sync.provider';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Patrón B (sincronización de credenciales) probado con `StubSyncProvider` (sin
 * hardware). Un terminal con `provider:'stub'` recibe las credenciales del scope
 * del inquilino; suspender/reactivar/revocar se propagan; la reconciliación
 * vuelca los registros del terminal a `access_logs`.
 */
describe('Dahua sync (Patrón B) con stub (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sincroniza al alta, propaga estado y reconcilia logs', async () => {
    const owner = await registerVerifiedUser(app, 'dahua-sync');
    await setTenantPlan(owner.slug, 'starter'); // starter incluye access_control
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    const tenantId = me.body.tenant.id as string;

    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Patrón B',
      unitsCount: 1,
    });

    // Terminal Patrón B (provider stub → StubSyncProvider).
    const dev = await request(app.getHttpServer())
      .post('/access/devices')
      .set(auth)
      .send({
        facilityId,
        type: 'door',
        name: 'Terminal ASI',
        hardwareId: 'asi-b-001',
        provider: 'stub',
      });
    expect(dev.status).toBe(201);
    const deviceId = dev.body.id as string;

    // Cliente con contrato ACTIVO en ese local (para que el scope incluya el local).
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Noa', lastName: 'Ruiz', country: 'ES' });
    const customerId = customer.body.id as string;
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: new Date().toISOString().slice(0, 10),
        priceMonthly: 50,
        billingCycle: 'monthly',
        cancellationNoticeDays: 30,
      });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .send({});

    const stub = app.get(StubSyncProvider);
    const credsSvc = app.get(AccessCredentialsService);

    // Alta de credencial PIN → se sincroniza al terminal en estado active.
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', allowedFacilityIds: [facilityId], allowedUnitIds: [] });
    expect(cred.status).toBe(201);
    const credentialId = cred.body.id as string;
    expect(stub.stateOf(deviceId, credentialId)).toBe('active');

    // Suspender por impago → se propaga al terminal.
    await credsSvc.suspend({
      tenantId,
      userId: me.body.user.id,
      id: credentialId,
      input: { reason: 'dunning:test' },
      meta: {},
    });
    expect(stub.stateOf(deviceId, credentialId)).toBe('suspended');

    // Reactivar → active de nuevo.
    await credsSvc.resume({ tenantId, userId: me.body.user.id, id: credentialId, meta: {} });
    expect(stub.stateOf(deviceId, credentialId)).toBe('active');

    // Reconciliación: el terminal reporta una apertura offline → llega a access_logs.
    stub.queueEvent(deviceId, {
      occurredAt: new Date(),
      credentialRef: null,
      method: 'pin',
      allowed: true,
    });
    const sync = app.get(DahuaSyncService);
    const rec = await sync.reconcileDevice(tenantId, deviceId);
    expect(rec.imported).toBe(1);
    const logs = await request(app.getHttpServer()).get('/access/logs').set(auth);
    const items = (logs.body.items ?? logs.body) as { reason: string | null }[];
    expect(items.some((l) => l.reason === 'reconciled_from_device')).toBe(true);

    // Revocar → se elimina del terminal.
    await credsSvc.revoke({ tenantId, userId: me.body.user.id, id: credentialId, meta: {} });
    expect(stub.stateOf(deviceId, credentialId)).toBeUndefined();
  });
});
