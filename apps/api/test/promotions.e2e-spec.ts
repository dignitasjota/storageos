import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Promotions (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  it('CRUD + validate de un código porcentual', async () => {
    const owner = await registerVerifiedUser(app, 'promo-crud');

    // Crear
    const create = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(owner.accessToken))
      .send({
        code: 'verano20',
        name: 'Verano 20%',
        discountType: 'percentage',
        discountValue: 20,
      });
    expect(create.status).toBe(201);
    expect(create.body.code).toBe('VERANO20'); // se normaliza a mayúsculas
    expect(create.body.usedCount).toBe(0);
    const id = create.body.id as string;

    // Código duplicado → 409
    const dup = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(owner.accessToken))
      .send({ code: 'VERANO20', name: 'Otro', discountType: 'fixed', discountValue: 5 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('promotion_code_taken');

    // Validar sobre 100€
    const val = await request(app.getHttpServer())
      .post('/promotions/validate')
      .set(auth(owner.accessToken))
      .send({ code: 'VERANO20', monthlyPrice: 100 });
    expect(val.status).toBe(200);
    expect(val.body).toMatchObject({ valid: true, discountAmount: 20, effectivePrice: 80 });

    // % no puede superar 100 → 400 al crear
    const bad = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(owner.accessToken))
      .send({ code: 'MAL', name: 'x', discountType: 'percentage', discountValue: 150 });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);

    // Update + list
    const upd = await request(app.getHttpServer())
      .patch(`/promotions/${id}`)
      .set(auth(owner.accessToken))
      .send({ isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body.isActive).toBe(false);

    // Inactiva → validate falla
    const valInactive = await request(app.getHttpServer())
      .post('/promotions/validate')
      .set(auth(owner.accessToken))
      .send({ code: 'VERANO20', monthlyPrice: 100 });
    expect(valInactive.body).toMatchObject({ valid: false, reason: 'inactive' });

    // free_months no soportado en validate de contrato
    await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(owner.accessToken))
      .send({ code: 'GRATIS', name: '1 mes', discountType: 'free_months', discountValue: 1 });
    const valFree = await request(app.getHttpServer())
      .post('/promotions/validate')
      .set(auth(owner.accessToken))
      .send({ code: 'GRATIS', monthlyPrice: 100 });
    expect(valFree.body).toMatchObject({ valid: false, reason: 'unsupported_type' });

    const list = await request(app.getHttpServer()).get('/promotions').set(auth(owner.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
  });

  it('aplica un código al crear el contrato: descuenta la cuota + incrementa usedCount', async () => {
    const owner = await registerVerifiedUser(app, 'promo-apply');
    const cId = await createCustomer(app, owner.accessToken, { email: 'p-apply@e2e.local' });
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(owner.accessToken))
      .send({ code: 'FIJO10', name: '10€ menos', discountType: 'fixed', discountValue: 10 });

    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth(owner.accessToken))
      .send({
        customerId: cId,
        unitId: unitIds[0],
        startDate: '2026-07-01',
        priceMonthly: 100,
        depositAmount: 0,
        promotionCode: 'FIJO10',
      });
    expect(contract.status).toBe(201);
    expect(Number(contract.body.discountAmount)).toBe(10);
    expect(contract.body.discountReason).toBe('Promoción FIJO10');

    // usedCount incrementado
    const list = await request(app.getHttpServer()).get('/promotions').set(auth(owner.accessToken));
    const promo = list.body.find((p: { code: string }) => p.code === 'FIJO10');
    expect(promo.usedCount).toBe(1);

    // Código inexistente → 404
    const bad = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth(owner.accessToken))
      .send({
        customerId: cId,
        unitId: unitIds[0],
        startDate: '2026-07-01',
        priceMonthly: 100,
        depositAmount: 0,
        promotionCode: 'NOEXISTE',
      });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('promotion_not_found');
  });
});
