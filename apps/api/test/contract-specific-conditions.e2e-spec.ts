import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { generalTermsHash } from './helpers/general-terms';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Condiciones propias de un contrato: van en lo que firma el inquilino y solo
 * se cambian en borrador.
 */
describe('Condiciones específicas de un contrato (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('van en el texto firmado, se editan en borrador y no tras la firma', async () => {
    const owner = await registerVerifiedUser(app, 'specificcond');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken, {
      email: `specific-${Date.now()}@e2e.local`,
    });

    const created = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 50,
        specificConditions: 'Si el local no abre el 1 de marzo, se puede cancelar sin coste.',
      })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.specificConditions).toBe(
      'Si el local no abre el 1 de marzo, se puede cancelar sin coste.',
    );

    // En borrador se cambian.
    const edited = await http()
      .patch(`/contracts/${id}`)
      .set(auth)
      .send({ specificConditions: 'Si el local no abre el 15 de marzo, se cancela sin coste.' })
      .expect(200);
    expect(edited.body.specificConditions).toContain('15 de marzo');

    const reqSig = await http().post(`/contracts/${id}/request-signature`).set(auth).expect(201);
    const token = new URL(reqSig.body.signingUrl as string).pathname.split('/').pop()!;
    const view = await http().get(`/public/move-in/sign/${token}`).expect(200);
    expect(view.body.termsText).toContain(
      'Condiciones específicas de este contrato:\nSi el local no abre el 15 de marzo',
    );

    await http()
      .post(`/public/move-in/sign/${token}`)
      .send({
        immediateStart: true,
        signerName: 'Ana García',
        method: 'typed',
        typedSignature: 'Ana García',
        accept: true,
        termsHash: view.body.termsHash,
        generalTermsHash: await generalTermsHash(app, token),
      })
      .expect(201);

    // Firmado: queda en el texto congelado y ya no se cambia.
    const signing = await http().get(`/contracts/${id}/signing`).set(auth).expect(200);
    expect(JSON.stringify(signing.body)).toContain('15 de marzo');
    const locked = await http()
      .patch(`/contracts/${id}`)
      .set(auth)
      .send({ specificConditions: 'Otra cosa' })
      .expect(400);
    expect(locked.body.code).toBe('contract_not_draft');
    expect(locked.body.message).toContain('anexo');

    // Vaciarlas en borrador las quita.
    const other = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-06-01',
        priceMonthly: 50,
        specificConditions: 'Algo',
      })
      .expect(201);
    const cleared = await http()
      .patch(`/contracts/${other.body.id as string}`)
      .set(auth)
      .send({ specificConditions: '' })
      .expect(200);
    expect(cleared.body.specificConditions).toBeNull();
  }, 60_000);
});
