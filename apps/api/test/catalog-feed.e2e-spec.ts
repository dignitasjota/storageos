import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Marketing — feed CSV del catálogo (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('requiere autenticación', async () => {
    await request(app.getHttpServer()).get('/marketing/catalog-feed').expect(401);
  });

  it('tenant vacío: solo cabecera + BOM', async () => {
    const owner = await registerVerifiedUser(app, 'catalog-feed-empty');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const res = await request(app.getHttpServer()).get('/marketing/catalog-feed').set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('catalogo-trasteros.csv');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('Local');
    expect(res.text).toContain('Precio/mes (IVA incl.)');
    // Solo la línea de cabecera (sin filas de datos).
    expect(res.text.trim().split('\r\n')).toHaveLength(1);
  });

  it('con local + trasteros disponibles: una fila por local × tipo, con IVA y filtro por local', async () => {
    const owner = await registerVerifiedUser(app, 'catalog-feed-data');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Catálogo',
      unitsCount: 2,
      pricePerUnit: 50,
    });
    await request(app.getHttpServer())
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ address: 'Calle Feed 1', city: 'Valencia', contactPhone: '600222333' })
      .expect(200);

    const res = await request(app.getHttpServer()).get('/marketing/catalog-feed').set(auth);
    expect(res.status).toBe(200);
    const withoutBom = res.text.charCodeAt(0) === 0xfeff ? res.text.slice(1) : res.text;
    const lines = withoutBom.trim().split('\r\n');
    expect(lines).toHaveLength(2); // cabecera + 1 fila
    const row = lines[1]!;
    expect(row).toContain('Local Catálogo');
    expect(row).toContain('Valencia');
    expect(row).toContain('60.50'); // 50 * 1.21 IVA incl.
    expect(row).toContain('600222333');

    // Filtro por local inexistente -> sin filas.
    const otherFacility = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Otro local',
      unitsCount: 1,
    });
    const filtered = await request(app.getHttpServer())
      .get(`/marketing/catalog-feed?facilityId=${otherFacility.facilityId}`)
      .set(auth);
    expect(filtered.text.trim().split('\r\n')).toHaveLength(2); // cabecera + su propia fila
    expect(filtered.text).not.toContain('Local Catálogo');
  });
});
