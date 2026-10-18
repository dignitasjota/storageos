import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ContractsService } from '../src/modules/contracts/contracts.service';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

describe('Baja con fecha, cierre automático y turnos de la lista de espera (e2e)', () => {
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

  async function signedContract(prefix: string) {
    const owner = await registerVerifiedUser(app, prefix);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], priceMonthly: 50, startDate: '2026-01-01' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(auth)
      .expect(200);
    return { owner, auth, contractId: contract.body.id as string, unitId: unitIds[0]! };
  }

  it('la baja desde el panel lleva fecha (por defecto, hoy + preaviso) y se cierra sola', async () => {
    const { auth, contractId, unitId } = await signedContract('autoend');

    // Sin cuerpo: hoy + 15 días de preaviso.
    const ending = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-end`)
      .set(auth)
      .expect(200);
    expect(ending.body.status).toBe('ending');
    expect(ending.body.endDate).toBeTruthy();

    // Con fecha propia; anterior al alta → 400.
    const bad = await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-end`)
      .set(auth)
      .send({ endDate: '2025-01-01' });
    expect(bad.status).toBe(400);

    // Llega la fecha (ayer): el cron lo finaliza y libera el trastero.
    await admin.contract.update({
      where: { id: contractId },
      data: { endDate: new Date(Date.now() - 2 * 86_400_000) },
    });
    const { ended } = await app.get(ContractsService).autoEndDue();
    expect(ended).toBeGreaterThanOrEqual(1);
    expect((await admin.contract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'ended',
    );
    expect((await admin.unit.findUniqueOrThrow({ where: { id: unitId } })).status).toBe(
      'available',
    );
  });

  it('con la finalización automática desactivada la baja se queda para cerrarla a mano', async () => {
    const { auth, contractId } = await signedContract('autoendoff');
    const tpl = await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ autoEndContracts: false })
      .expect(200);
    expect(tpl.body.autoEndContracts).toBe(false);
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/request-end`)
      .set(auth)
      .send({ endDate: '2026-02-01' })
      .expect(200);
    await app.get(ContractsService).autoEndDue();
    expect((await admin.contract.findUniqueOrThrow({ where: { id: contractId } })).status).toBe(
      'ending',
    );
  });

  it('un aviso de la lista de espera sin respuesta en 48 h pasa al siguiente', async () => {
    const owner = await registerVerifiedUser(app, 'wlexpiry');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitTypeId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const { tenantId } = await admin.facility.findUniqueOrThrow({ where: { id: facilityId } });
    const first = await admin.waitlistEntry.create({
      data: {
        tenantId,
        facilityId,
        unitTypeId,
        contactName: 'Ana',
        contactEmail: 'ana-wl@example.com',
        status: 'notified',
        notifiedAt: new Date(Date.now() - 49 * 3_600_000),
      },
    });
    const second = await request(app.getHttpServer()).post('/waitlist').set(auth).send({
      facilityId,
      unitTypeId,
      contactName: 'Beto',
      contactEmail: 'beto-wl@example.com',
    });
    expect(second.status).toBe(201);

    await app.get(WaitlistService).expireStaleNotifications();
    expect((await admin.waitlistEntry.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      'expired',
    );
    expect(
      (await admin.waitlistEntry.findUniqueOrThrow({ where: { id: second.body.id } })).status,
    ).toBe('notified');
  });
});
