import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Plantilla de contrato editable por el tenant: las cláusulas propias (con
 * variables {{...}}) se renderizan en la vista de firma y se congelan al firmar.
 */
describe('Plantilla de contrato editable (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  async function signViewFor(owner: { accessToken: string }, customerId: string, unitId: string) {
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: '2026-02-01', priceMonthly: 75, depositAmount: 150 });
    expect(contract.status).toBe(201);
    const reqSign = await request(app.getHttpServer())
      .post(`/contracts/${contract.body.id}/request-signature`)
      .set(auth);
    expect(reqSign.status).toBe(201);
    const token = (reqSign.body.signingUrl as string).split('/sign/')[1];
    const view = await request(app.getHttpServer()).get(`/public/move-in/sign/${token}`);
    expect(view.status).toBe(200);
    return { contractId: contract.body.id as string, termsText: view.body.termsText as string };
  }

  it('las cláusulas del tenant se renderizan en la firma; vacío = condiciones por defecto', async () => {
    const owner = await registerVerifiedUser(app, 'ctpl');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 75,
    });
    const customerId = await createCustomer(app, owner.accessToken);

    // Sin plantilla → sin sección de condiciones particulares.
    const before = await signViewFor(owner, customerId, unitIds[0]);
    expect(before.termsText).not.toContain('Condiciones particulares');

    // Definir cláusulas propias con una variable.
    const clauses = 'Preaviso de baja: {{cancellationNoticeDays}} dias. REF-CLAUSULA-TEST';
    const patch = await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ clauses });
    expect(patch.status).toBe(200);
    expect(patch.body.clauses).toBe(clauses);

    const get = await request(app.getHttpServer())
      .get('/settings/tenant/contract-template')
      .set(auth);
    expect(get.body.clauses).toBe(clauses);

    // La vista de firma de un contrato NUEVO renderiza la cláusula (15 = preaviso por defecto).
    const withTpl = await signViewFor(owner, customerId, unitIds[1]);
    expect(withTpl.termsText).toContain('Condiciones particulares:');
    expect(withTpl.termsText).toContain('Preaviso de baja: 15 dias');
    expect(withTpl.termsText).toContain('REF-CLAUSULA-TEST');
    // La variable se sustituyó (no queda el literal {{...}}).
    expect(withTpl.termsText).not.toContain('{{cancellationNoticeDays}}');

    // Vaciar la plantilla → vuelve a null (condiciones por defecto).
    const clear = await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ clauses: '' });
    expect(clear.body.clauses).toBeNull();
  });

  it('sin permiso settings:manage no puede editar la plantilla', async () => {
    await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .send({ clauses: 'x' })
      .expect(401);
  });
});
