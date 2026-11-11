import request from 'supertest';

import { AEAT_CLIENT, type AeatClient } from '../src/modules/billing/aeat-client';
import { VerifactuDispatcher } from '../src/modules/billing/verifactu-dispatcher.service';
import { VerifactuStatusPollerCron } from '../src/modules/billing/verifactu-status-poller.cron';
import { VerifactuService } from '../src/modules/billing/verifactu.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import {
  createDraftInvoice,
  quiesceVerifactuQueue,
  recordsOf,
  waitForAeatStatus,
} from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants, enableVerifactu } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type {
  SendBatchArgs,
  SendBatchResult,
} from '../src/modules/billing/aeat-client/aeat-client';
import type { INestApplication } from '@nestjs/common';

/**
 * Control de flujo de Veri*Factu (art. 16.2 de la Orden HAC/1177/2024): lo
 * pendiente de un emisor sale en un solo envío, se espera entre envíos lo que
 * pide la AEAT y un envío que falla se repite más tarde sin parar a los demás.
 * La AEAT se simula con su espera de 60 segundos.
 */
describe('Veri*Factu: envíos en lotes y control de flujo (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;
  let aeat: AeatClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
    aeat = app.get(AEAT_CLIENT);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    // Los envíos que quedaron esperando a la AEAT simulada no salen ya.
    await quiesceVerifactuQueue(app);
    await app.close();
    await cleanupTestTenants();
  });

  const http = () => request(app.getHttpServer());

  function accepted(args: SendBatchArgs, csv: string): SendBatchResult {
    return {
      outcome: 'sent',
      emitterTaxId: 'B12345674',
      recordCount: args.recordIds.length,
      status: 'accepted',
      csv,
      waitSeconds: 60,
      results: Object.fromEntries(
        args.recordIds.map((id) => [id, { status: 'accepted' as const, csv }]),
      ),
    };
  }

  /** Las facturas de unos registros, en el orden en que se enviaron. */
  async function invoicesOf(recordIds: readonly string[]): Promise<string[]> {
    const rows = await admin.verifactuRecord.findMany({
      where: { id: { in: [...recordIds] } },
      select: { id: true, invoiceId: true },
    });
    return recordIds.map((id) => rows.find((r) => r.id === id)!.invoiceId);
  }

  async function issue(token: string, customerId: string): Promise<string> {
    const id = await createDraftInvoice(app, token, customerId);
    await http()
      .post(`/invoices/${id}/issue`)
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    return id;
  }

  it('lo emitido mientras la AEAT pide esperar sale junto en el siguiente envío', async () => {
    const owner = await registerVerifiedUser(app, 'vfflow');
    await enableVerifactu(owner.slug);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const calls: string[][] = [];
    jest.spyOn(aeat, 'sendBatch').mockImplementation(async (args) => {
      calls.push(await invoicesOf(args.recordIds));
      return accepted(args, `CSV-${calls.length}`);
    });

    const first = await issue(owner.accessToken, customerId);
    expect(await waitForAeatStatus(app, owner.accessToken, first)).toBe('accepted');
    expect(calls).toEqual([[first]]);

    // La AEAT ha pedido 60 segundos: lo siguiente espera.
    const second = await issue(owner.accessToken, customerId);
    const third = await issue(owner.accessToken, customerId);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(calls).toHaveLength(1);
    const pending = await admin.invoice.findMany({
      where: { id: { in: [second, third] } },
      select: { aeatStatus: true },
    });
    expect(pending.map((p) => p.aeatStatus)).toEqual(['pending', 'pending']);

    const emitter = await admin.verifactuEmitter.findFirstOrThrow({
      where: { tenantId: owner.tenantId, emitterKey: 'self' },
    });
    expect(emitter.waitSeconds).toBe(60);
    expect(emitter.nextSendAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    // El panel lo cuenta: el último envío y cuándo sale el siguiente.
    const settings = await http().get('/billing/verifactu/settings').set(auth).expect(200);
    expect(settings.body.pendingCount).toBe(2);
    expect(settings.body.lastSubmission).toMatchObject({
      status: 'accepted',
      csv: 'CSV-1',
      recordCount: 1,
      acceptedCount: 1,
      waitSeconds: 60,
      ownerName: null,
    });
    expect(new Date(settings.body.nextSendAt).getTime()).toBe(emitter.nextSendAt!.getTime());

    // Pasada la espera, las dos salen en un solo envío y en orden.
    await admin.verifactuEmitter.update({
      where: { id: emitter.id },
      data: { nextSendAt: new Date(Date.now() - 1_000) },
    });
    const run = await app.get(VerifactuService).sendPending(owner.tenantId, null);
    expect(run).toMatchObject({ submissions: 1, records: 2 });
    expect(calls[1]).toEqual([second, third]);
    const done = await admin.invoice.findMany({
      where: { id: { in: [second, third] } },
      select: { aeatStatus: true, aeatCsv: true },
    });
    expect(done).toEqual([
      { aeatStatus: 'accepted', aeatCsv: 'CSV-2' },
      { aeatStatus: 'accepted', aeatCsv: 'CSV-2' },
    ]);

    const list = await http().get('/billing/verifactu/submissions').set(auth).expect(200);
    expect(list.body.map((s: { csv: string }) => s.csv)).toEqual(['CSV-2', 'CSV-1']);
    expect(list.body[0]).toMatchObject({ recordCount: 2, acceptedCount: 2, rejectedCount: 0 });
  });

  it('un envío sin respuesta se repite más tarde y no para a otro negocio', async () => {
    const a = await registerVerifiedUser(app, 'vfflowa');
    const b = await registerVerifiedUser(app, 'vfflowb');
    await enableVerifactu(a.slug);
    await enableVerifactu(b.slug);
    const customerA = await createCustomer(app, a.accessToken);
    const customerB = await createCustomer(app, b.accessToken);
    jest.spyOn(aeat, 'sendBatch').mockImplementation(async (args) =>
      args.tenantId === a.tenantId
        ? {
            outcome: 'failed',
            emitterTaxId: 'B12345674',
            recordCount: args.recordIds.length,
            message: 'timeout',
            results: Object.fromEntries(
              args.recordIds.map((id) => [id, { status: 'error' as const, message: 'timeout' }]),
            ),
          }
        : accepted(args, 'CSV-B'),
    );

    const invA = await issue(a.accessToken, customerA);
    expect(await waitForAeatStatus(app, a.accessToken, invA)).toBe('error');
    const invB = await issue(b.accessToken, customerB);
    expect(await waitForAeatStatus(app, b.accessToken, invB)).toBe('accepted');

    const emitterA = await admin.verifactuEmitter.findFirstOrThrow({
      where: { tenantId: a.tenantId, emitterKey: 'self' },
    });
    expect(emitterA.consecutiveFailures).toBe(1);
    expect(emitterA.lastError).toBe('timeout');
    // Primer reintento al minuto (después, cada vez más tarde y como mucho cada hora).
    const retryIn = emitterA.retryAt!.getTime() - Date.now();
    expect(retryIn).toBeGreaterThan(50_000);
    expect(retryIn).toBeLessThanOrEqual(60_000);
    const failedSubmission = await admin.verifactuSubmission.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    expect(failedSubmission).toMatchObject({ status: 'error', recordCount: 1, message: 'timeout' });
    // Sale tarde por una incidencia: el registro queda marcado y el panel lo avisa
    // con el número de facturas sin enviar (art. 16.4 de la Orden).
    expect((await recordsOf(app, invA))[0]!.incident).toBe(true);
    const alertA = await http()
      .get('/billing/verifactu/alert')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .expect(200);
    expect(alertA.body).toMatchObject({
      unsentCount: 1,
      lastError: 'No se ha podido conectar con la AEAT. Se vuelve a intentar.',
    });
    const alertB = await http()
      .get('/billing/verifactu/alert')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .expect(200);
    expect(alertB.body).toEqual({ unsentCount: 0, since: null, lastError: null });

    // «Reenviar» no espera al reintento, pero sí la espera entre envíos. Lo que
    // no llegó se repite tal cual (no es una subsanación).
    const schedule = jest.spyOn(app.get(VerifactuDispatcher), 'schedule');
    const resent = await http()
      .post(`/billing/invoices/${invA}/resend-aeat`)
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .expect(202);
    expect(resent.body).toEqual({ queued: true, invoiceId: invA, subsanacion: false });
    expect(await recordsOf(app, invA)).toHaveLength(1);
    expect(schedule).toHaveBeenCalledWith(a.tenantId, null, { retryNow: true });
    const afterResend = await admin.verifactuEmitter.findUniqueOrThrow({
      where: { id: emitterA.id },
    });
    expect(afterResend.retryAt).toBeNull();
    const runAt = await schedule.mock.results[0]!.value;
    expect((runAt as Date).getTime()).toBe(afterResend.nextSendAt!.getTime());
  });

  it('la tarea periódica vuelve a programar a quien tiene registros quietos', async () => {
    const owner = await registerVerifiedUser(app, 'vfflowcron');
    await enableVerifactu(owner.slug);
    const customerId = await createCustomer(app, owner.accessToken);
    jest.spyOn(aeat, 'sendBatch').mockImplementation(async (args) => accepted(args, 'CSV-C'));
    const id = await issue(owner.accessToken, customerId);
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');
    // Un registro que se quedó sin trabajo (Redis reiniciado…).
    await admin.$executeRaw`UPDATE verifactu_records SET status = 'pending', updated_at = now() - interval '1 hour' WHERE invoice_id = ${id}::uuid`;

    const schedule = jest.spyOn(app.get(VerifactuDispatcher), 'schedule');
    await app.get(VerifactuStatusPollerCron).requeueStalled();
    expect(schedule).toHaveBeenCalledWith(owner.tenantId, null);
  });
});
