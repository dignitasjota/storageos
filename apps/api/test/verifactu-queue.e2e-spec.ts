import { Job } from 'bullmq';
import request from 'supertest';

import { VerifactuDispatcher } from '../src/modules/billing/verifactu-dispatcher.service';
import { VerifactuProcessor } from '../src/modules/billing/verifactu.processor';
import { VerifactuService } from '../src/modules/billing/verifactu.service';
import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, setAeatStatus, waitForAeatStatus } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants, enableVerifactu } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { VerifactuSendJobData } from '../src/modules/billing/verifactu-dispatcher.service';
import type { INestApplication } from '@nestjs/common';

/**
 * Cola BullMQ `verifactu` + endpoint `POST /billing/invoices/:id/resend-aeat`.
 *
 *   1. El endpoint `resend-aeat` (validación de estado, aislamiento por tenant
 *      vía RLS, respuesta `{ queued: true }`).
 *   2. El worker `VerifactuProcessor` aislado: un trabajo es un emisor (el
 *      negocio o un propietario) y envía lo pendiente con `sendPending`; un
 *      fallo de la AEAT no lanza (el propio envío programa el reintento).
 */
describe('Verifactu queue + resend-aeat (e2e)', () => {
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

  // ────────────────────────────────────────────────────────────────────
  // Endpoint POST /billing/invoices/:id/resend-aeat
  // ────────────────────────────────────────────────────────────────────

  it('resendAeat resetea aeat_* y devuelve { queued: true } sobre una factura emitida', async () => {
    const owner = await registerVerifiedUser(app, 'verif-resend-ok');
    await enableVerifactu(owner.slug);
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 80,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued.status).toBe(200);

    // El envío corre en el worker (in-process en los tests).
    expect(await waitForAeatStatus(app, owner.accessToken, id)).toBe('accepted');

    let before = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(before.body.aeatStatus).toBe('accepted');
    // Una aceptada no se reenvía (sería un alta duplicada en la AEAT): se
    // reenvía tras un error.
    await request(app.getHttpServer())
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(400);
    await setAeatStatus(app, id, 'error');
    before = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const resend = await request(app.getHttpServer())
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(resend.status).toBe(202);
    expect(resend.body).toEqual({ queued: true, invoiceId: id, subsanacion: false });

    // El endpoint deja la factura pendiente y programa el envío de su emisor;
    // el worker la vuelve a enviar y queda 'accepted' con un aeat_sent_at nuevo.
    let after: { aeatStatus: string | null; aeatSentAt: string | null } | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await request(app.getHttpServer())
        .get(`/invoices/${id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`);
      after = res.body;
      if (after?.aeatStatus === 'accepted' && after.aeatSentAt !== before.body.aeatSentAt) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(after?.aeatStatus).toBe('accepted');
    expect(after?.aeatSentAt).not.toBe(before.body.aeatSentAt);
  });

  it('resendAeat sobre factura en draft devuelve 400', async () => {
    const owner = await registerVerifiedUser(app, 'verif-resend-draft');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    const resend = await request(app.getHttpServer())
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(resend.status).toBe(400);
    expect(resend.body.code).toBe('invoice_draft_not_sendable');
  });

  it('resendAeat sobre factura de otro tenant devuelve 404 (RLS)', async () => {
    const ownerA = await registerVerifiedUser(app, 'verif-resend-a');
    const ownerB = await registerVerifiedUser(app, 'verif-resend-b');
    const customerA = await createCustomer(app, ownerA.accessToken);
    const idA = await createDraftInvoice(app, ownerA.accessToken, customerA, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${idA}/issue`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`);
    expect(issued.status).toBe(200);

    const cross = await request(app.getHttpServer())
      .post(`/billing/invoices/${idA}/resend-aeat`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`);
    expect(cross.status).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────
  // VerifactuProcessor (handler aislado)
  // ────────────────────────────────────────────────────────────────────

  function job(data: VerifactuSendJobData, name = JOB_VERIFACTU_SEND): Job<VerifactuSendJobData> {
    return { name, data } as unknown as Job<VerifactuSendJobData>;
  }

  it('el trabajo envía lo pendiente de su emisor', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest
      .spyOn(service, 'sendPending')
      .mockResolvedValue({ submissions: 1, records: 3, nextRunAt: null });

    await expect(
      processor.process(job({ tenantId: 'tenant-1', ownerId: null })),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('tenant-1', null);
    await processor.process(job({ tenantId: 'tenant-1', ownerId: 'owner-1' }));
    expect(spy).toHaveBeenLastCalledWith('tenant-1', 'owner-1');
    spy.mockRestore();
  });

  it('un fallo de la AEAT no lanza: el propio envío deja programado el reintento', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest
      .spyOn(service, 'sendPending')
      .mockResolvedValue({ submissions: 1, records: 1, nextRunAt: new Date(Date.now() + 60_000) });

    await expect(
      processor.process(job({ tenantId: 'tenant-2', ownerId: null })),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('un trabajo de antes (uno por factura) envía lo pendiente del emisor de esa factura', async () => {
    const owner = await registerVerifiedUser(app, 'verif-legacy-job');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, { unitPrice: 30 });
    const other = await registerVerifiedUser(app, 'verif-legacy-other');

    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest
      .spyOn(service, 'sendPending')
      .mockResolvedValue({ submissions: 0, records: 0, nextRunAt: null });

    await processor.process(job({ invoiceId: id, tenantId: owner.tenantId }));
    expect(spy).toHaveBeenCalledWith(owner.tenantId, null);
    // Una factura de otro negocio no sirve para el trabajo de este.
    spy.mockClear();
    await processor.process(job({ invoiceId: id, tenantId: other.tenantId }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('worker handler ignora jobs con nombre distinto a send-to-aeat', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest.spyOn(service, 'sendPending');

    await expect(
      processor.process(job({ tenantId: 'tenant-x', ownerId: null }, 'unknown-job')),
    ).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emitir una factura programa el envío de su emisor en la cola verifactu', async () => {
    const owner = await registerVerifiedUser(app, 'verif-issue-enq');
    await enableVerifactu(owner.slug);
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 60,
    });
    // @ts-expect-error acceso al campo privado para inspeccion en test.
    const queue = app.get(VerifactuDispatcher).queue;
    const addSpy = jest.spyOn(queue, 'add');

    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);

    // Un trabajo por emisor y hora de salida (lo que se emite mientras
    // tanto va en el mismo envío).
    expect(addSpy).toHaveBeenCalledWith(
      JOB_VERIFACTU_SEND,
      { tenantId: owner.tenantId, ownerId: null },
      expect.objectContaining({
        jobId: expect.stringMatching(new RegExp(`^vf-${owner.tenantId}-self-\\d+$`)),
        removeOnComplete: true,
      }),
    );
    expect(QUEUE_VERIFACTU).toBe('verifactu');
    addSpy.mockRestore();
  });
});
