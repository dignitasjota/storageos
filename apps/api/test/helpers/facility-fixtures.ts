import request from 'supertest';

import type { INestApplication } from '@nestjs/common';

/**
 * Crea una facility + un unit_type + N units en estado available.
 * Devuelve los IDs para encadenar tests.
 */
export async function createFacilityWithUnits(
  app: INestApplication,
  accessToken: string,
  opts: {
    facilityName?: string;
    typeName?: string;
    unitsCount?: number;
    pricePerUnit?: number;
  } = {},
): Promise<{
  facilityId: string;
  unitTypeId: string;
  unitIds: string[];
  floorId: string;
}> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const facilityRes = await request(app.getHttpServer())
    .post('/facilities')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: opts.facilityName ?? `Local ${stamp}`,
      city: 'Madrid',
      country: 'ES',
      timezone: 'Europe/Madrid',
    });
  if (facilityRes.status !== 201) {
    throw new Error(
      `facility create failed ${facilityRes.status}: ${JSON.stringify(facilityRes.body)}`,
    );
  }
  const facilityId = facilityRes.body.id as string;

  const typeRes = await request(app.getHttpServer())
    .post('/unit-types')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: opts.typeName ?? `Tipo ${stamp}`,
      defaultPriceMonthly: opts.pricePerUnit ?? 50,
      color: '#3366ff',
    });
  if (typeRes.status !== 201) {
    throw new Error(`unit_type create failed ${typeRes.status}: ${JSON.stringify(typeRes.body)}`);
  }
  const unitTypeId = typeRes.body.id as string;

  const unitsCount = opts.unitsCount ?? 0;
  const unitIds: string[] = [];
  let floorId = '';
  for (let i = 0; i < unitsCount; i++) {
    const res = await request(app.getHttpServer())
      .post('/units')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        facilityId,
        unitTypeId,
        code: `U-${i + 1}-${stamp}`,
        widthM: 2,
        depthM: 3,
        heightM: 2.5,
        basePriceMonthly: opts.pricePerUnit ?? 50,
      });
    if (res.status !== 201) {
      throw new Error(`unit create failed ${res.status}: ${JSON.stringify(res.body)}`);
    }
    unitIds.push(res.body.id as string);
    floorId = res.body.floorId as string;
  }

  return { facilityId, unitTypeId, unitIds, floorId };
}
