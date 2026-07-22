import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Win-back automático de bajas: N días tras irse (sin contrato activo) se envía
 * la oferta de vuelta, una sola vez por ex-cliente.
 */
describe('Win-back automático (e2e)', () => {
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

  async function createCustomer(auth: object, email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Ex', lastName: 'Cliente', email, country: 'ES' })
      .expect(201);
    return res.body.id as string;
  }

  async function endedContract(
    auth: object,
    customerId: string,
    unitId: string,
    endDaysAgo: number,
  ): Promise<void> {
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: '2026-01-01', priceMonthly: 80, depositAmount: 0 });
    const id = create.body.id as string;
    await request(app.getHttpServer()).post(`/contracts/${id}/sign`).set(auth).expect(200);
    await request(app.getHttpServer()).post(`/contracts/${id}/end`).set(auth).expect(200);
    // Backdatea la baja para que cumpla el plazo del win-back.
    await admin.contract.update({
      where: { id },
      data: { endDate: new Date(Date.now() - endDaysAgo * 24 * 60 * 60 * 1000) },
    });
  }

  it('envía la oferta al ex-cliente que cumple el plazo, una sola vez', async () => {
    const owner = await registerVerifiedUser(app, 'winback-auto');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });

    // A: se fue hace 100 días → elegible.
    const oldId = await createCustomer(auth, 'oldleaver@e2e.local');
    await endedContract(auth, oldId, unitIds[0]!, 100);

    // B: se fue ayer → aún no cumple el plazo (90 días).
    const recentId = await createCustomer(auth, 'recentleaver@e2e.local');
    await endedContract(auth, recentId, unitIds[1]!, 1);

    // Config por defecto: deshabilitado.
    const off = await request(app.getHttpServer()).get('/campaigns/winback-settings').set(auth);
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);
    expect(off.body.delayDays).toBe(90);

    // Deshabilitado → run no envía nada.
    const noop = await request(app.getHttpServer()).post('/campaigns/winback/run').set(auth);
    expect(noop.body.sent).toBe(0);

    // Activar.
    const on = await request(app.getHttpServer())
      .patch('/campaigns/winback-settings')
      .set(auth)
      .send({ enabled: true, subject: 'Vuelve con {{tenant.name}}' });
    expect(on.body.enabled).toBe(true);

    // Run → solo A (100 días); B (1 día) no cumple el plazo.
    const run1 = await request(app.getHttpServer()).post('/campaigns/winback/run').set(auth);
    expect(run1.status).toBe(200);
    expect(run1.body.sent).toBe(1);

    // Idempotente: un 2º run no reenvía.
    const run2 = await request(app.getHttpServer()).post('/campaigns/winback/run').set(auth);
    expect(run2.body.sent).toBe(0);

    // La comunicación quedó registrada para el ex-cliente elegible.
    const comms = await request(app.getHttpServer())
      .get(`/communications?customerId=${oldId}`)
      .set(auth);
    expect(comms.status).toBe(200);
    expect(comms.body.some((c: { source: string | null }) => c.source === 'winback.auto')).toBe(
      true,
    );
  });

  it('los ajustes exigen autenticación', async () => {
    await request(app.getHttpServer()).get('/campaigns/winback-settings').expect(401);
  });
});
