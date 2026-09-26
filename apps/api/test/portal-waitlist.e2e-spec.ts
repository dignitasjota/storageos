import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Lista de espera desde el portal: el inquilino ve los tipos AGOTADOS de sus
 * locales, se apunta (idempotente), aparece en la cola del staff y puede salir.
 */
describe('Portal: lista de espera (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  /** Sesión de portal vía enlace generado por el staff (sin pasar por email). */
  async function portalLogin(staffToken: string, customerId: string): Promise<string> {
    const gen = await request(app.getHttpServer())
      .post(`/customers/${customerId}/portal-link`)
      .set({ Authorization: `Bearer ${staffToken}` })
      .expect(201);
    const token = new URL(gen.body.url as string).searchParams.get('token')!;
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token })
      .expect(200);
    return consume.body.accessToken as string;
  }

  it('ve los tipos agotados de su local, se apunta, sale de la cola; nada de locales ajenos', async () => {
    const owner = await registerVerifiedUser(app, 'pwait');
    const staff = { Authorization: `Bearer ${owner.accessToken}` };
    // Un solo trastero de ese tipo: al alquilarlo, el tipo queda agotado.
    const { facilityId, unitTypeId, unitIds } = await createFacilityWithUnits(
      app,
      owner.accessToken,
      { unitsCount: 1, pricePerUnit: 50 },
    );
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `pwait-${Date.now()}@e2e.local`,
    });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(staff)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 50 });
    await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/sign`)
      .set(staff)
      .send({})
      .expect(200);

    const pAuth = { Authorization: `Bearer ${await portalLogin(owner.accessToken, customerId)}` };

    const view = await request(app.getHttpServer()).get('/portal/me/waitlist').set(pAuth);
    expect(view.status).toBe(200);
    expect(view.body.entries).toHaveLength(0);
    const opt = view.body.options.find((o: { facilityId: string }) => o.facilityId === facilityId);
    expect(opt.unitTypes.map((u: { id: string }) => u.id)).toContain(unitTypeId);
    // El otro local (sin contrato) no se ofrece.
    expect(
      view.body.options.some((o: { facilityId: string }) => o.facilityId === other.facilityId),
    ).toBe(false);

    // Se apunta; repetir no duplica.
    const joined = await request(app.getHttpServer())
      .post('/portal/me/waitlist')
      .set(pAuth)
      .send({ facilityId, unitTypeId });
    expect(joined.status).toBe(201);
    expect(joined.body.entries).toHaveLength(1);
    expect(joined.body.entries[0].status).toBe('waiting');
    const again = await request(app.getHttpServer())
      .post('/portal/me/waitlist')
      .set(pAuth)
      .send({ facilityId, unitTypeId });
    expect(again.body.entries).toHaveLength(1);

    // El staff lo ve en su cola, vinculado al cliente.
    const staffList = await request(app.getHttpServer()).get('/waitlist').set(staff);
    const staffEntry = (
      staffList.body as Array<{ customerId: string | null; unitTypeId: string }>
    ).find((e) => e.customerId === customerId);
    expect(staffEntry?.unitTypeId).toBe(unitTypeId);

    // Un local donde no es cliente → 404.
    await request(app.getHttpServer())
      .post('/portal/me/waitlist')
      .set(pAuth)
      .send({ facilityId: other.facilityId, unitTypeId: other.unitTypeId })
      .expect(404);

    // Sale de la cola.
    const left = await request(app.getHttpServer())
      .delete(`/portal/me/waitlist/${joined.body.entries[0].id as string}`)
      .set(pAuth);
    expect(left.status).toBe(200);
    expect(left.body.entries).toHaveLength(0);
  });

  it('sin sesión de portal → 401', async () => {
    await request(app.getHttpServer()).get('/portal/me/waitlist').expect(401);
  });
});
