import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';

import { PrismaAdminService } from '../../src/modules/database/prisma-admin.service';
import { QUEUE_VERIFACTU } from '../../src/modules/queues/queues.module';

import type { INestApplication } from '@nestjs/common';
import type { AeatStatus } from '@storageos/database';
import type { Queue } from 'bullmq';

/**
 * Deja quieta la cola `verifactu` antes de cerrar la app: espera a que acabe el
 * envío que esté en marcha (el de la última factura emitida) y quita los
 * programados. Cerrar con un envío a medias puede dejar el cierre esperándolo.
 */
export async function quiesceVerifactuQueue(app: INestApplication): Promise<void> {
  const queue = app.get<Queue>(getQueueToken(QUEUE_VERIFACTU), { strict: false });
  for (let i = 0; i < 100 && (await queue.getActiveCount()) > 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await queue.drain(true);
}

/**
 * Pone a mano el estado en la AEAT del último registro de una factura (y el de
 * la factura, que enseña el de su último registro).
 */
export async function setAeatStatus(
  app: INestApplication,
  invoiceId: string,
  status: AeatStatus,
  message?: string,
): Promise<void> {
  const admin = app.get(PrismaAdminService);
  const latest = await admin.verifactuRecord.findFirstOrThrow({
    where: { invoiceId },
    orderBy: { chainSeq: 'desc' },
  });
  await admin.verifactuRecord.update({
    where: { id: latest.id },
    data: { status, ...(message ? { response: { mode: 'stub', message } } : {}) },
  });
  await admin.invoice.update({ where: { id: invoiceId }, data: { aeatStatus: status } });
}

/** Los registros de Veri*Factu de una factura, en el orden de la cadena. */
export async function recordsOf(app: INestApplication, invoiceId: string) {
  return app.get(PrismaAdminService).verifactuRecord.findMany({
    where: { invoiceId },
    orderBy: { chainSeq: 'asc' },
  });
}

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

/**
 * Espera (polling) a que el job BullMQ `verifactu` procese el envio AEAT de
 * la factura. El `issue` deja `aeatStatus='pending'` y encola el job; el
 * processor in-process lo resuelve milisegundos despues, pero la respuesta
 * HTTP del issue puede ganarle la carrera. Los asserts sobre `aeatStatus`
 * deben pasar por aqui, nunca leerse del body del issue.
 */
export async function waitForAeatStatus(
  app: INestApplication,
  accessToken: string,
  invoiceId: string,
  opts: Partial<{ timeoutMs: number; intervalMs: number }> = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let last = 'pending';
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    last = res.body.aeatStatus as string;
    if (last && last !== 'pending') return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`aeatStatus sigue '${last}' tras ${timeoutMs}ms (invoice ${invoiceId})`);
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
