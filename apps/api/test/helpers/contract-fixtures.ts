import request from 'supertest';

import type { INestApplication } from '@nestjs/common';

/**
 * Da al inquilino un contrato firmado (en marcha) en un trastero nuevo del
 * local indicado (o de uno nuevo). Los accesos que pide el propio inquilino
 * (adicionales, pases nocturnos, visitas) exigen un trastero en uso.
 */
export async function signedContractFor(
  app: INestApplication,
  accessToken: string,
  customer: { id?: string; email?: string },
  facilityId?: string,
): Promise<{ contractId: string; facilityId: string; unitId: string }> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const http = () => request(app.getHttpServer());
  let customerId = customer.id;
  if (!customerId) {
    const list = await http().get('/customers').set(auth).query({ search: customer.email });
    const rows = (Array.isArray(list.body) ? list.body : list.body.items) as {
      id: string;
      email: string | null;
    }[];
    customerId = rows.find((c) => c.email?.toLowerCase() === customer.email?.toLowerCase())?.id;
    if (!customerId) throw new Error(`customer ${customer.email} not found`);
  }
  let fid = facilityId;
  if (!fid) {
    const f = await http()
      .post('/facilities')
      .set(auth)
      .send({ name: `Local ${Date.now().toString(36)}`, city: 'Madrid', postalCode: '28001' });
    fid = f.body.id as string;
  }
  const type = await http()
    .post('/unit-types')
    .set(auth)
    .send({ name: `T${Math.random().toString(36).slice(2, 6)}`, defaultPriceMonthly: 50 });
  const unit = await http()
    .post('/units')
    .set(auth)
    .send({
      facilityId: fid,
      unitTypeId: type.body.id,
      code: `C${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      widthM: 2,
      depthM: 2,
      heightM: 2,
      basePriceMonthly: 50,
    });
  const contract = await http().post('/contracts').set(auth).send({
    customerId,
    unitId: unit.body.id,
    startDate: '2026-01-01',
    priceMonthly: 50,
    depositAmount: 0,
  });
  await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);
  return {
    contractId: contract.body.id as string,
    facilityId: fid,
    unitId: unit.body.id as string,
  };
}
