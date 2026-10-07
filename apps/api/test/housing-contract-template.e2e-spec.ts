import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Contratos de vivienda: plantilla LAU propia, separada de la de trasteros. */
describe('Plantilla de contrato de vivienda (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('la vivienda usa la base LAU o la del tenant; el trastero no cambia', async () => {
    const owner = await registerVerifiedUser(app, 'housingtpl');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await setTenantFeatureOverride(owner.slug, 'housing', true);
    const storage = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 75,
    });
    const housing = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 2,
      pricePerUnit: 700,
    });
    await request(app.getHttpServer())
      .patch(`/unit-types/${housing.unitTypeId}`)
      .set(auth)
      .send({ propertyKind: 'housing' })
      .expect(200);
    const customerId = await createCustomer(app, owner.accessToken);

    const signView = async (unitId: string, price: number) => {
      const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
        customerId,
        unitId,
        startDate: '2026-02-01',
        priceMonthly: price,
        depositAmount: 700,
      });
      const reqSign = await request(app.getHttpServer())
        .post(`/contracts/${contract.body.id}/request-signature`)
        .set(auth)
        .expect(201);
      const token = (reqSign.body.signingUrl as string).split('/sign/')[1];
      const view = await request(app.getHttpServer())
        .get(`/public/move-in/sign/${token}`)
        .expect(200);
      return view.body.termsText as string;
    };

    // Vivienda sin plantilla propia → base LAU con las variables sustituidas.
    const base = await signView(housing.unitIds[0]!, 700);
    expect(base).toContain('Contrato de arrendamiento de vivienda');
    expect(base).toContain('Ley 29/1994');
    expect(base).toContain('La renta es de 700.00 €');
    expect(base).toContain('de la vivienda indicada');
    expect(base).not.toContain('{{');

    // Trastero: sigue igual (sin condiciones particulares ni texto de vivienda).
    const store = await signView(storage.unitIds[0]!, 75);
    expect(store).toContain('Contrato de alquiler de trastero');
    expect(store).not.toContain('Condiciones particulares');

    // Plantilla de vivienda propia; la de trasteros no se toca.
    const saved = await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ housingClauses: 'CLAUSULA-VIVIENDA {{unitCode}}' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      clauses: null,
      housingClauses: 'CLAUSULA-VIVIENDA {{unitCode}}',
    });
    const custom = await signView(housing.unitIds[1]!, 700);
    expect(custom).toContain('CLAUSULA-VIVIENDA');
    expect(custom).not.toContain('Ley 29/1994');

    // Vaciarla vuelve a la base.
    const reset = await request(app.getHttpServer())
      .patch('/settings/tenant/contract-template')
      .set(auth)
      .send({ housingClauses: '' });
    expect(reset.body.housingClauses).toBeNull();
  });
});
