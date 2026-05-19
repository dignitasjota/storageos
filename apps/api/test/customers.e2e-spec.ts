import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Customers (e2e)', () => {
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

  it('CRUD customer individual con KYC toggle', async () => {
    const owner = await registerVerifiedUser(app, 'cust-crud');
    const id = await createCustomer(app, owner.accessToken);

    const list = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].displayName).toContain('Cliente');
    expect(list.body[0].kycVerified).toBe(false);

    // Patch
    const upd = await request(app.getHttpServer())
      .patch(`/customers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ phone: '+34 600 111 222' });
    expect(upd.status).toBe(200);
    expect(upd.body.phone).toBe('+34 600 111 222');

    // KYC verify
    const kyc = await request(app.getHttpServer())
      .post(`/customers/${id}/kyc`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ verified: true, notes: 'DNI ok' });
    expect(kyc.status).toBe(201);
    expect(kyc.body.kycVerified).toBe(true);
    expect(kyc.body.kycVerifiedAt).toBeTruthy();

    // Soft delete
    const del = await request(app.getHttpServer())
      .delete(`/customers/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(del.status).toBe(204);

    const listAfter = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(listAfter.body).toHaveLength(0);
  });

  it('business sin companyName -> 400', async () => {
    const owner = await registerVerifiedUser(app, 'cust-business');
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ customerType: 'business', country: 'ES' });
    expect(res.status).toBe(400);
  });

  it('search por documentNumber', async () => {
    const owner = await registerVerifiedUser(app, 'cust-search');
    await createCustomer(app, owner.accessToken, { documentNumber: '12345678X' });
    await createCustomer(app, owner.accessToken, { documentNumber: '87654321Y' });

    const res = await request(app.getHttpServer())
      .get('/customers?search=12345')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].documentNumber).toBe('12345678X');
  });

  it('upload-url devuelve signed URL para documento', async () => {
    const owner = await registerVerifiedUser(app, 'cust-doc');
    const id = await createCustomer(app, owner.accessToken);
    const res = await request(app.getHttpServer())
      .post(`/customers/${id}/documents/upload-url`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        type: 'id_front',
        mimeType: 'image/jpeg',
        sizeBytes: 50000,
        fileName: 'dni.jpg',
      });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(res.body.publicUrl).toMatch(/^https?:\/\//);
    expect(res.body.requiredHeaders['Content-Type']).toBe('image/jpeg');
  });
});
