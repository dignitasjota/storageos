import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

describe('Motivo de pérdida de los contactos (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('se guarda al perderlo, se limpia al reabrirlo y alimenta informes y precios', async () => {
    const owner = await registerVerifiedUser(app, 'leadlost');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const facility = await request(app.getHttpServer())
      .post('/facilities')
      .set(auth)
      .send({ name: 'Local Leads', addressLine1: 'C/ L 1', city: 'Madrid', postalCode: '28001' });
    const unitType = await request(app.getHttpServer())
      .post('/unit-types')
      .set(auth)
      .send({ name: 'Mediano', defaultPriceMonthly: 100 });
    const unit = await request(app.getHttpServer()).post('/units').set(auth).send({
      facilityId: facility.body.id,
      unitTypeId: unitType.body.id,
      code: 'LL-001',
      widthM: 2,
      depthM: 2,
      heightM: 2.5,
      basePriceMonthly: 100,
    });

    const newLead = (name: string) =>
      request(app.getHttpServer())
        .post('/leads')
        .set(auth)
        .send({ source: 'manual', firstName: name, preferredUnitTypeId: unitType.body.id });

    // Dos perdidos porque les pareció caro y uno abierto que pide ese tamaño.
    const ids: string[] = [];
    for (const name of ['Ana', 'Luis']) {
      const l = await newLead(name);
      ids.push(l.body.id as string);
      const lost = await request(app.getHttpServer())
        .post(`/leads/${l.body.id}/transition`)
        .set(auth)
        .send({ status: 'lost', lostReasonCode: 'too_expensive', reason: 'Busca algo más barato' });
      expect(lost.status).toBe(201);
      expect(lost.body.lostReasonCode).toBe('too_expensive');
      expect(lost.body.lostReason).toBe('Busca algo más barato');
    }
    await newLead('Eva').expect(201);

    // Motivo inventado → 400.
    await request(app.getHttpServer())
      .post(`/leads/${ids[0]}/transition`)
      .set(auth)
      .send({ status: 'new', lostReasonCode: 'porque_si' })
      .expect(400);

    const funnel = await request(app.getHttpServer()).get('/analytics/leads-funnel').set(auth);
    expect(funnel.body.lostReasons).toEqual([{ reason: 'too_expensive', count: 2 }]);

    const sug = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item = sug.body.items.find((i: { unitId: string }) => i.unitId === unit.body.id);
    const labels = item.factors.map((f: { label: string }) => f.label);
    expect(labels).toContain('Contactos interesados');
    expect(labels).toContain('Perdidos por precio');

    // Reabrir uno: deja de contar como perdido.
    const reopened = await request(app.getHttpServer())
      .post(`/leads/${ids[0]}/transition`)
      .set(auth)
      .send({ status: 'new' });
    expect(reopened.body.lostReasonCode).toBeNull();
    expect(reopened.body.lostAt).toBeNull();
    const sug2 = await request(app.getHttpServer())
      .get('/analytics/unit-pricing-suggestions')
      .set(auth);
    const item2 = sug2.body.items.find((i: { unitId: string }) => i.unitId === unit.body.id);
    expect(item2.factors.map((f: { label: string }) => f.label)).not.toContain(
      'Perdidos por precio',
    );
  });
});
