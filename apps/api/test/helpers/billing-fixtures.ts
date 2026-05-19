import request from 'supertest';

import type { INestApplication } from '@nestjs/common';

export async function ensureDefaultSeries(
  app: INestApplication,
  accessToken: string,
): Promise<string> {
  const list = await request(app.getHttpServer())
    .get('/invoice-series')
    .set('Authorization', `Bearer ${accessToken}`);
  const defaultOne = (list.body as Array<{ id: string; isDefault: boolean }>).find(
    (s) => s.isDefault,
  );
  if (defaultOne) return defaultOne.id;
  const res = await request(app.getHttpServer())
    .post('/invoice-series')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      code: 'A',
      name: 'Serie principal',
      prefix: 'FA',
      yearScope: true,
      isDefault: true,
    });
  if (res.status !== 201) {
    throw new Error(`series create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

export async function createDraftInvoice(
  app: INestApplication,
  accessToken: string,
  customerId: string,
  opts: Partial<{ unitPrice: number; quantity: number; description: string }> = {},
): Promise<string> {
  await ensureDefaultSeries(app, accessToken);
  const res = await request(app.getHttpServer())
    .post('/invoices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      customerId,
      items: [
        {
          description: opts.description ?? 'Cuota mes',
          quantity: opts.quantity ?? 1,
          unitPrice: opts.unitPrice ?? 100,
          taxRate: 21,
        },
      ],
    });
  if (res.status !== 201) {
    throw new Error(`invoice create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}
