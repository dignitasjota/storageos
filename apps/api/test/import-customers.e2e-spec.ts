import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const CSV = [
  'customerType,firstName,lastName,email',
  'individual,Ana,García,ana@import.local',
  'individual,,,bob@import.local',
  'individual,Dup,Cliente,dup@import.local',
].join('\n');

describe('Import customers (e2e)', () => {
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

  it('requiere autenticación', async () => {
    const res = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .send({ csv: CSV });
    expect(res.status).toBe(401);
  });

  it('la plantilla incluye las cabeceras canónicas', async () => {
    const owner = await registerVerifiedUser(app, 'imp-template');
    const res = await request(app.getHttpServer())
      .get('/imports/customers/template')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.csv).toContain('customerType');
    expect(res.body.csv).toContain('documentNumber');
  });

  it('preview detecta válidos, errores y duplicados', async () => {
    const owner = await registerVerifiedUser(app, 'imp-preview');
    // Pre-crea el cliente que provocará el duplicado por email.
    await createCustomer(app, owner.accessToken, { email: 'dup@import.local' });

    const res = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv: CSV });

    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ total: 3, valid: 1, invalid: 1, duplicates: 1 });
    const byStatus = (s: string) =>
      res.body.rows.filter((r: { status: string }) => r.status === s).length;
    expect(byStatus('valid')).toBe(1);
    expect(byStatus('error')).toBe(1);
    expect(byStatus('duplicate')).toBe(1);
  });

  it('commit crea los válidos, omite duplicados y reporta errores', async () => {
    const owner = await registerVerifiedUser(app, 'imp-commit');
    await createCustomer(app, owner.accessToken, { email: 'dup@import.local' });

    const res = await request(app.getHttpServer())
      .post('/imports/customers/commit')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv: CSV, onDuplicate: 'skip' });

    expect(res.status).toBe(201);
    expect(res.body.summary).toEqual({ created: 1, skipped: 1, errors: 1 });

    // La lista de clientes incluye el pre-creado + el importado.
    const list = await request(app.getHttpServer())
      .get('/customers')
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(list.body.some((c: { email: string | null }) => c.email === 'ana@import.local')).toBe(
      true,
    );
  });

  it('los duplicados se evalúan por tenant (RLS)', async () => {
    // El email dup@import.local existe en otros tenants, pero este es nuevo.
    const owner = await registerVerifiedUser(app, 'imp-isolation');
    const res = await request(app.getHttpServer())
      .post('/imports/customers/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        csv: 'customerType,firstName,lastName,email\nindividual,Dup,Cliente,dup@import.local',
      });

    expect(res.status).toBe(201);
    expect(res.body.summary.valid).toBe(1);
    expect(res.body.summary.duplicates).toBe(0);
  });
});
