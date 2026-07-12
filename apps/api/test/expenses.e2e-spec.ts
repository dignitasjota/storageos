import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Gastos del operador + cuenta de resultados (P&L) por local: CRUD + el gasto se
 * imputa a su local y resta en el resultado.
 */
describe('Gastos + P&L (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('CRUD de gastos + el P&L imputa el gasto al local (resultado = facturado − gasto)', async () => {
    const owner = await registerVerifiedUser(app, 'expenses');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;

    // Crear un gasto imputado al local.
    const created = await request(app.getHttpServer()).post('/expenses').set(auth).send({
      facilityId,
      category: 'utilities',
      description: 'Factura de luz',
      amount: 100,
      expenseDate: today,
      vendor: 'Iberdrola',
    });
    expect(created.status).toBe(201);
    expect(created.body.amount).toBe(100);
    expect(created.body.facilityName).toBeTruthy();
    const expenseId = created.body.id as string;

    // Listar → aparece.
    const list = await request(app.getHttpServer()).get('/expenses').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    // P&L del mes: el local tiene 100 € de gastos y resultado −100 (sin ingresos aún).
    const pnl = await request(app.getHttpServer())
      .get(`/expenses/profit-loss?from=${monthStart}&to=${today}`)
      .set(auth);
    expect(pnl.status).toBe(200);
    const row = (pnl.body.rows as { facilityId: string; expenses: number; net: number }[]).find(
      (r) => r.facilityId === facilityId,
    );
    expect(row).toBeDefined();
    expect(row!.expenses).toBe(100);
    expect(row!.net).toBe(-100);
    expect(pnl.body.totals.expenses).toBe(100);
    const util = (pnl.body.byCategory as { category: string; amount: number }[]).find(
      (c) => c.category === 'utilities',
    );
    expect(util?.amount).toBe(100);

    // Editar el importe.
    const updated = await request(app.getHttpServer())
      .patch(`/expenses/${expenseId}`)
      .set(auth)
      .send({ amount: 150 });
    expect(updated.status).toBe(200);
    expect(updated.body.amount).toBe(150);

    // Borrar.
    await request(app.getHttpServer()).delete(`/expenses/${expenseId}`).set(auth).expect(204);
    const after = await request(app.getHttpServer()).get('/expenses').set(auth);
    expect(after.body).toHaveLength(0);
  });

  it('sin autenticación → 401', async () => {
    await request(app.getHttpServer()).get('/expenses').expect(401);
  });
});
