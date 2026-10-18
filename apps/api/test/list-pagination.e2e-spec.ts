import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

interface Page {
  items: { id: string }[];
  nextCursor: string | null;
}

/** Listas del panel paginadas por cursor (`GET …/page`). */
describe('Listas paginadas (e2e)', () => {
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

  /** Recorre todas las páginas de 2 en 2 y devuelve los ids en orden. */
  async function walk(path: string, auth: Record<string, string>): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await http()
        .get(`${path}${sep}limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(auth)
        .expect(200);
      const page = res.body as Page;
      expect(page.items.length).toBeLessThanOrEqual(2);
      ids.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return ids;
  }

  it('cada lista se recorre entera por páginas, sin repetir ni saltarse filas', async () => {
    const owner = await registerVerifiedUser(app, 'paging');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 5 });

    const customers: string[] = [];
    for (let i = 0; i < 5; i++) {
      customers.push(await createCustomer(app, owner.accessToken, { firstName: `Pag${i}` }));
    }
    for (let i = 0; i < 5; i++) {
      const c = await http().post('/contracts').set(auth).send({
        customerId: customers[i],
        unitId: unitIds[i],
        startDate: '2026-01-01',
        priceMonthly: 50,
        depositAmount: 0,
      });
      const inv = await http()
        .post('/invoices')
        .set(auth)
        .send({
          customerId: customers[i],
          contractId: c.body.id,
          items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
        })
        .expect(201);
      await http().post(`/invoices/${inv.body.id}/issue`).set(auth).expect(200);
      await http()
        .post(`/invoices/${inv.body.id}/mark-paid`)
        .set(auth)
        .send({ amount: 60.5, methodType: 'cash' })
        .expect(200);
      await http()
        .post('/tasks')
        .set(auth)
        .send({ title: `Tarea ${i}` })
        .expect(201);
      await http()
        .post('/incidents')
        .set(auth)
        .send({ title: `Incidencia ${i}` })
        .expect(201);
      await http()
        .post('/expenses')
        .set(auth)
        .send({
          category: 'other',
          description: `Gasto ${i}`,
          amount: 10 + i,
          expenseDate: '2026-02-01',
        })
        .expect(201);
      await http()
        .post('/leads')
        .set(auth)
        .send({ firstName: `Lead${i}`, email: `lead${i}-${Date.now()}@e2e.local` })
        .expect(201);
    }

    for (const path of [
      '/customers/page',
      '/contracts/page',
      '/invoices/page',
      '/payments/page',
      '/tasks/page',
      '/incidents/page',
      '/expenses/page',
      '/leads/page',
    ]) {
      const ids = await walk(path, auth);
      expect({ path, count: ids.length }).toEqual({ path, count: 5 });
      expect(new Set(ids).size).toBe(5);
    }

    // Búsqueda en el servidor.
    const found = await http().get('/customers/page?search=Pag3').set(auth).expect(200);
    expect((found.body as Page).items).toHaveLength(1);
    // Por palabras: nombre y apellido en campos distintos.
    const lastName = (await http().get(`/customers/${customers[3]}`).set(auth).expect(200)).body
      .lastName as string;
    const byWords = await http()
      .get(`/customers/page?search=${encodeURIComponent(`Pag3 ${lastName}`)}`)
      .set(auth)
      .expect(200);
    expect((byWords.body as Page).items.map((c) => c.id)).toEqual([customers[3]]);
    const tasks = await http().get('/tasks/page?search=Tarea%202').set(auth).expect(200);
    expect((tasks.body as Page).items).toHaveLength(1);

    // Cursor que no es un id → 400.
    await http().get('/invoices/page?cursor=nope').set(auth).expect(400);
  });
});
