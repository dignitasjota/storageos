import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Redondeo de IVA POR LÍNEA: los totales de la cabecera deben ser la suma
 * exacta de las líneas ya redondeadas (criterio AEAT/Veri*Factu). Caso
 * elegido para que el criterio antiguo (redondeo global) difiera: dos líneas
 * de 1.55 € al 21% → cuota por línea 0.3255→0.33 (Σ 0.66) vs global
 * 0.651→0.65.
 */
describe('Redondeo de facturas por línea (e2e)', () => {
  let app: INestApplication;
  let auth: { Authorization: string };
  let customerId: string;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    const owner = await registerVerifiedUser(app, 'rounding');
    auth = { Authorization: `Bearer ${owner.accessToken}` };
    customerId = await createCustomer(app, owner.accessToken);
    await ensureDefaultSeries(app, owner.accessToken);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('la cabecera cuadra exactamente con la suma de las líneas', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        items: [
          { description: 'Línea A', quantity: 1, unitPrice: 1.55, taxRate: 21 },
          { description: 'Línea B', quantity: 1, unitPrice: 1.55, taxRate: 21 },
        ],
      })
      .expect(201);

    const inv = res.body;
    // Por línea: cuota 0.33 cada una, total de línea 1.88 cada una.
    expect(inv.items).toHaveLength(2);
    for (const item of inv.items) {
      expect(Number(item.taxAmount)).toBe(0.33);
      expect(Number(item.total)).toBe(1.88);
    }
    // Cabecera = Σ líneas redondeadas (no redondeo global, que daría 0.65/3.75).
    expect(Number(inv.taxAmount)).toBe(0.66);
    expect(Number(inv.total)).toBe(3.76);
    expect(Number(inv.subtotal)).toBe(3.1);

    // Invariante: total == Σ items.total y cuota == Σ items.taxAmount.
    const sumTotals = inv.items.reduce(
      (s: number, it: { total: string }) => s + Number(it.total),
      0,
    );
    const sumTax = inv.items.reduce(
      (s: number, it: { taxAmount: string }) => s + Number(it.taxAmount),
      0,
    );
    expect(Number(inv.total)).toBeCloseTo(sumTotals, 10);
    expect(Number(inv.taxAmount)).toBeCloseTo(sumTax, 10);
  });
});
