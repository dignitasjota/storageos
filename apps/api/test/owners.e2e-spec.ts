import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Plan Administrador: propietarios, local por propietario y contrato con su propietario. */
describe('Propietarios (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('sin la funcionalidad no hay propietarios; con ella se asignan al local y al contrato', async () => {
    const owner = await registerVerifiedUser(app, 'owners');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    await http().get('/owners').set(auth).expect(403);

    await setTenantFeatureOverride(owner.slug, 'multi_owner', true);
    const created = await http().post('/owners').set(auth).send({
      legalName: 'Inversiones Pérez SL',
      taxId: 'b12345674',
      iban: 'ES91 2100 0418 4502 0005 1332',
      feeType: 'percentage',
      feeValue: 8,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      legalName: 'Inversiones Pérez SL',
      taxId: 'B12345674',
      ibanLast4: '1332',
      feeValue: 8,
      facilitiesCount: 0,
    });
    // NIF repetido o no válido.
    await http()
      .post('/owners')
      .set(auth)
      .send({ legalName: 'Otro', taxId: 'B12345674' })
      .expect(409);
    await http().post('/owners').set(auth).send({ legalName: 'Otro', taxId: 'B1234' }).expect(400);

    const fac = await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ ownerId: created.body.id });
    expect(fac.status).toBe(200);
    expect(fac.body).toMatchObject({ ownerId: created.body.id, ownerName: 'Inversiones Pérez SL' });

    const list = await http().get('/owners').set(auth).expect(200);
    expect(list.body[0].facilitiesCount).toBe(1);

    const customerId = await createCustomer(app, owner.accessToken);
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-01-01',
      priceMonthly: 100,
      depositAmount: 0,
    });
    expect(contract.status).toBe(201);
    expect(contract.body).toMatchObject({
      ownerId: created.body.id,
      ownerName: 'Inversiones Pérez SL',
    });

    // Quitar el propietario del local no cambia el del contrato ya creado.
    await http().patch(`/facilities/${facilityId}`).set(auth).send({ ownerId: null }).expect(200);
    const again = await http().get(`/contracts/${contract.body.id}`).set(auth).expect(200);
    expect(again.body.ownerId).toBe(created.body.id);

    // Tras bajar de plan no se puede asignar uno nuevo, pero sí quitarlo.
    await setTenantFeatureOverride(owner.slug, 'multi_owner', false);
    await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ ownerId: created.body.id })
      .expect(403);
    await http().patch(`/facilities/${facilityId}`).set(auth).send({ ownerId: null }).expect(200);
  });
});
