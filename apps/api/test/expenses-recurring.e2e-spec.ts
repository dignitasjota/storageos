import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Gastos recurrentes: la plantilla genera un gasto al mes (idempotente).
 */
describe('Gastos recurrentes (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('la plantilla genera un gasto este mes y no lo duplica al re-ejecutar', async () => {
    const owner = await registerVerifiedUser(app, 'rec-exp');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    // Plantilla recurrente (día 1 → siempre vencida este mes).
    const created = await request(app.getHttpServer()).post('/expenses/recurring').set(auth).send({
      facilityId,
      category: 'rent',
      description: 'Alquiler del local',
      amount: 800,
      dayOfMonth: 1,
    });
    expect(created.status).toBe(201);
    expect(created.body.lastGeneratedMonth).toBeNull();
    expect(created.body.active).toBe(true);

    // Generar ahora → crea 1 gasto.
    const run1 = await request(app.getHttpServer()).post('/expenses/recurring/run').set(auth);
    expect(run1.status).toBe(201);
    expect(run1.body.created).toBe(1);

    // El gasto aparece en la lista, marcado como generado automáticamente.
    const list = await request(app.getHttpServer()).get('/expenses').set(auth);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].amount).toBe(800);
    expect(list.body[0].category).toBe('rent');

    // La plantilla ya tiene lastGeneratedMonth.
    const recurring = await request(app.getHttpServer()).get('/expenses/recurring').set(auth);
    expect(recurring.body).toHaveLength(1);
    expect(recurring.body[0].lastGeneratedMonth).not.toBeNull();

    // Re-ejecutar el mismo mes → NO duplica.
    const run2 = await request(app.getHttpServer()).post('/expenses/recurring/run').set(auth);
    expect(run2.body.created).toBe(0);
    const list2 = await request(app.getHttpServer()).get('/expenses').set(auth);
    expect(list2.body).toHaveLength(1);

    // Pausar la plantilla → deja de generar.
    const paused = await request(app.getHttpServer())
      .patch(`/expenses/recurring/${created.body.id}`)
      .set(auth)
      .send({ active: false });
    expect(paused.body.active).toBe(false);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer()).get('/expenses/recurring').expect(401);
  });
});
