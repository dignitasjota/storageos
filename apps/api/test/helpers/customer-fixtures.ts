import request from 'supertest';

import type { INestApplication } from '@nestjs/common';

export async function createCustomer(
  app: INestApplication,
  accessToken: string,
  overrides: Partial<{
    firstName: string;
    lastName: string;
    email: string;
    documentNumber: string;
  }> = {},
): Promise<string> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const res = await request(app.getHttpServer())
    .post('/customers')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      customerType: 'individual',
      firstName: overrides.firstName ?? `Cliente ${stamp}`,
      lastName: overrides.lastName ?? 'Apellido',
      email: overrides.email ?? `cli-${stamp}@e2e.local`,
      documentNumber: overrides.documentNumber ?? `${stamp}-X`,
      country: 'ES',
    });
  if (res.status !== 201) {
    throw new Error(`customer create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}
