import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Espera activa: reintenta `fn` hasta que devuelva truthy o se agote el timeout. */
async function eventually<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Al finalizar un contrato se emite `contract_ended` → AccessIntegrationsService
 * revoca las credenciales del inquilino SI no le queda ningún contrato vivo.
 */
describe('Contrato finalizado → revoca accesos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  const statusOf = async (auth: Record<string, string>, credId: string): Promise<string> => {
    const list = await request(app.getHttpServer()).get('/access/credentials').set(auth);
    const found = (list.body as { id: string; status: string }[]).find((c) => c.id === credId);
    return found?.status ?? 'missing';
  };

  it('finalizar el último contrato revoca la credencial; con otro vivo NO', async () => {
    const owner = await registerVerifiedUser(app, 'endaccess');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Dos contratos activos del mismo inquilino (dos trasteros).
    const mkContract = async (unitId: string): Promise<string> => {
      const c = await request(app.getHttpServer()).post('/contracts').set(auth).send({
        customerId,
        unitId,
        startDate: '2026-05-01',
        priceMonthly: 50,
        depositAmount: 0,
      });
      await request(app.getHttpServer()).post(`/contracts/${c.body.id}/sign`).set(auth).expect(200);
      return c.body.id as string;
    };
    const c1 = await mkContract(unitIds[0]!);
    const c2 = await mkContract(unitIds[1]!);

    // Credencial PIN del inquilino.
    const cred = await request(app.getHttpServer())
      .post('/access/credentials')
      .set(auth)
      .send({ customerId, method: 'pin', pin: '4321', allowedHours: {} });
    expect(cred.status).toBe(201);
    const credId = cred.body.id as string;
    expect(await statusOf(auth, credId)).toBe('active');

    // Finalizo el PRIMER contrato: al inquilino le queda c2 vivo → NO se revoca.
    await request(app.getHttpServer()).post(`/contracts/${c1}/end`).set(auth).expect(200);
    // Damos margen al listener async y comprobamos que sigue activa.
    await new Promise((r) => setTimeout(r, 800));
    expect(await statusOf(auth, credId)).toBe('active');

    // Finalizo el SEGUNDO (último) contrato → sin contratos vivos → se revoca.
    await request(app.getHttpServer()).post(`/contracts/${c2}/end`).set(auth).expect(200);
    const finalStatus = await eventually(async () => {
      const s = await statusOf(auth, credId);
      return s === 'revoked' ? s : '';
    });
    expect(finalStatus).toBe('revoked');
  });
});
