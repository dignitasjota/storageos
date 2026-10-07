import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const IBAN_OK = 'ES91 2100 0418 4502 0005 1332';

describe('Importar mandatos SEPA (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('valida, conserva la referencia y la secuencia, y omite a quien ya tiene mandato', async () => {
    const owner = await registerVerifiedUser(app, 'impsepa');
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const ana = await createCustomer(app, owner.accessToken, { email: 'ana@sepa.local' });
    await createCustomer(app, owner.accessToken, {
      email: 'luis@sepa.local',
      documentNumber: '12345678Z',
    });
    const marta = await createCustomer(app, owner.accessToken, { email: 'marta@sepa.local' });
    // Marta ya tiene un mandato activo.
    await request(app.getHttpServer())
      .post('/sepa/mandates')
      .set(auth)
      .send({ customerId: marta, iban: IBAN_OK, signedAt: '2025-01-01' })
      .expect(201);

    const csv = [
      'Email,DNI,IBAN,BIC,Fecha firma,Referencia,Ya cobrado',
      `ana@sepa.local,,${IBAN_OK},CAIXESBBXXX,15/03/2024,MND-OLD-1,sí`,
      `,12345678Z,${IBAN_OK},,2024-04-01,,no`,
      `marta@sepa.local,,${IBAN_OK},,2024-05-01,MND-OLD-3,sí`,
      `nadie@sepa.local,,${IBAN_OK},,2024-05-01,MND-OLD-4,`,
      `ana@sepa.local,,ES00 0000 0000 0000 0000 0000,,2024-05-01,MND-OLD-5,`,
      `ana@sepa.local,,${IBAN_OK},,2024-05-01,MND-OLD-1,`,
    ].join('\n');

    const preview = await request(app.getHttpServer())
      .post('/imports/sepa-mandates/preview')
      .set(auth)
      .send({ csv });
    expect(preview.status).toBe(201);
    // 2 válidas, 1 duplicada (Marta), 3 con error (sin inquilino, IBAN, referencia repetida).
    expect(preview.body.summary).toEqual({ total: 6, valid: 2, invalid: 3, duplicates: 1 });

    const commit = await request(app.getHttpServer())
      .post('/imports/sepa-mandates/commit')
      .set(auth)
      .send({ csv, onDuplicate: 'skip' });
    expect(commit.status).toBe(201);
    expect(commit.body.summary.created).toBe(2);
    expect(commit.body.summary.skipped).toBe(1);

    const anaMandate = await admin.sepaMandate.findFirst({
      where: { customerId: ana, status: 'active' },
    });
    expect(anaMandate).toMatchObject({
      reference: 'MND-OLD-1',
      sequenceType: 'RCUR',
      ibanLast4: '1332',
      bic: 'CAIXESBBXXX',
    });
    expect(anaMandate?.signedAt.toISOString().slice(0, 10)).toBe('2024-03-15');
    const luis = await admin.sepaMandate.findFirst({
      where: {
        tenantId: owner.tenantId,
        reference: { not: 'MND-OLD-1' },
        customerId: { not: marta },
      },
    });
    expect(luis?.sequenceType).toBe('FRST');
    expect(luis?.reference.startsWith('MND-')).toBe(true);

    // Reimportar con la misma referencia: error, no se duplica.
    const again = await request(app.getHttpServer())
      .post('/imports/sepa-mandates/preview')
      .set(auth)
      .send({
        csv: `Email,IBAN,Fecha firma,Referencia\nmarta@sepa.local,${IBAN_OK},2024-05-01,MND-OLD-1`,
      });
    expect(again.body.summary.invalid).toBe(1);
  });

  it('requiere el módulo SEPA en el plan y sesión', async () => {
    await request(app.getHttpServer()).post('/imports/sepa-mandates/preview').expect(401);
    const owner = await registerVerifiedUser(app, 'impsepastarter');
    await request(app.getHttpServer())
      .post('/imports/sepa-mandates/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ csv: 'Email,IBAN\nx@x.local,ES91' })
      .expect(403);
  });
});
