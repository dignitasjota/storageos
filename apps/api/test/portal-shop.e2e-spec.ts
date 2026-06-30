import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Portal — tienda de accesorios (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    await deleteAllMessages();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function portalLogin(slug: string, email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/portal/login/request')
      .send({ tenantSlug: slug, email })
      .expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await request(app.getHttpServer())
      .post('/portal/login/consume')
      .send({ token });
    return consume.body.accessToken as string;
  }

  it('el inquilino compra un accesorio y le queda una factura emitida', async () => {
    const owner = await registerVerifiedUser(app, 'pshop');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `pshop-${Date.now()}@e2e.local`;
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, owner.accessToken, { email });

    // Serie de facturación por defecto (la venta con customer emite factura).
    await ensureDefaultSeries(app, owner.accessToken);

    // Producto + stock en el local.
    const prod = await request(app.getHttpServer())
      .post('/products')
      .set(auth)
      .send({ sku: 'LOCK1', name: 'Candado', type: 'lock', price: 10, taxRate: 21 });
    expect(prod.status).toBe(201);
    const productId = prod.body.id as string;
    await request(app.getHttpServer())
      .put(`/products/${productId}/stock`)
      .set(auth)
      .send({ facilityId, quantity: 5 })
      .expect(200);

    // Contrato firmado (para resolver el local del inquilino).
    const create = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: '2026-01-01', priceMonthly: 80 });
    await request(app.getHttpServer())
      .post(`/contracts/${create.body.id}/sign`)
      .set(auth)
      .expect(200);

    const portalToken = await portalLogin(owner.slug, email);
    const pAuth = { Authorization: `Bearer ${portalToken}` };

    // Catálogo.
    const products = await request(app.getHttpServer()).get('/portal/me/products').set(pAuth);
    expect(products.status).toBe(200);
    expect(products.body.some((p: { id: string }) => p.id === productId)).toBe(true);

    // Comprar.
    const buy = await request(app.getHttpServer())
      .post('/portal/me/purchases')
      .set(pAuth)
      .send({ items: [{ productId, quantity: 2 }] });
    expect(buy.status).toBe(201);
    expect(buy.body.invoiceId).toBeTruthy();
    expect(buy.body.total).toBeCloseTo(24.2, 2); // 2 × 10 × 1.21

    // La factura aparece en el portal del inquilino.
    const invoices = await request(app.getHttpServer()).get('/portal/me/invoices').set(pAuth);
    expect(invoices.body.some((i: { id: string }) => i.id === buy.body.invoiceId)).toBe(true);

    // Stock decrementado.
    const after = await request(app.getHttpServer()).get('/portal/me/products').set(pAuth);
    const refreshed = after.body.find((p: { id: string }) => p.id === productId);
    expect(refreshed.totalStock).toBe(3);
  });

  it('sin contrato activo no puede comprar', async () => {
    const owner = await registerVerifiedUser(app, 'pshopx');
    const email = `pshopx-${Date.now()}@e2e.local`;
    await createCustomer(app, owner.accessToken, { email });
    const portalToken = await portalLogin(owner.slug, email);

    const res = await request(app.getHttpServer())
      .post('/portal/me/purchases')
      .set({ Authorization: `Bearer ${portalToken}` })
      .send({ items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('no_active_contract');
  });

  it('exige sesión de portal', async () => {
    const r = await request(app.getHttpServer()).get('/portal/me/products');
    expect(r.status).toBe(401);
  });
});
