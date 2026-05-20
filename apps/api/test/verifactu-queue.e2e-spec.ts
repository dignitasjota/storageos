import { Job } from 'bullmq';
import request from 'supertest';

import { InvoicesService } from '../src/modules/billing/invoices.service';
import { VerifactuProcessor } from '../src/modules/billing/verifactu.processor';
import { VerifactuService } from '../src/modules/billing/verifactu.service';
import { JOB_VERIFACTU_SEND, QUEUE_VERIFACTU } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { SendInvoiceResult } from '../src/modules/billing/aeat-client/aeat-client';
import type { INestApplication } from '@nestjs/common';

/**
 * Fase 10A.4 — cola BullMQ `verifactu` con retry exponencial + endpoint
 * `POST /billing/invoices/:id/resend-aeat`.
 *
 * Estos tests cubren dos planos:
 *   1. El endpoint HTTP `resend-aeat` (validacion de estado, aislamiento
 *      por tenant via RLS, respuesta `{ queued: true }`).
 *   2. El handler del worker `VerifactuProcessor` aislado: se mockea
 *      `VerifactuService.sendToAeat` con `jest.spyOn` y se comprueba la
 *      politica de retry: `error` lanza (BullMQ reintentara), `accepted` /
 *      `rejected` resuelven sin lanzar.
 *
 * No instanciamos workers de BullMQ contra Redis para evitar
 * dependencias de timing.
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
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 80,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued.status).toBe(200);

    // El issue encola, pero como el envio real (stub) corre asincrono en
    // BullMQ y aqui no esperamos al worker, podemos forzar nosotros un
    // estado conocido invocando sendToAeat directamente. No es necesario
    // para el test, pero asegura que aeat_status no sea null.
    const service = app.get(VerifactuService);
    await service.sendToAeat(id, owner.tenantId);

    const before = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(before.body.aeatStatus).toBe('accepted');

    const resend = await request(app.getHttpServer())
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(resend.status).toBe(202);
    expect(resend.body).toEqual({ queued: true, invoiceId: id });

    const after = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(after.body.aeatStatus).toBeNull();
    expect(after.body.aeatSentAt).toBeNull();
    expect(after.body.aeatCsv).toBeNull();
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

  it('worker handler con result.status="accepted" NO lanza (no se reintenta)', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest.spyOn(service, 'sendToAeat').mockResolvedValueOnce({
      status: 'accepted',
      csv: 'CSV-FAKE-OK',
    } satisfies SendInvoiceResult);

    const job = {
      name: JOB_VERIFACTU_SEND,
      data: { invoiceId: 'inv-1', tenantId: 'tenant-1' },
    } as unknown as Job<{ invoiceId: string; tenantId: string }>;

    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith('inv-1', 'tenant-1');
    spy.mockRestore();
  });

  it('worker handler con result.status="rejected" NO lanza (decision firme de AEAT)', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest.spyOn(service, 'sendToAeat').mockResolvedValueOnce({
      status: 'rejected',
      message: 'NIF emisor invalido',
    } satisfies SendInvoiceResult);

    const job = {
      name: JOB_VERIFACTU_SEND,
      data: { invoiceId: 'inv-2', tenantId: 'tenant-2' },
    } as unknown as Job<{ invoiceId: string; tenantId: string }>;

    await expect(processor.process(job)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('worker handler con result.status="error" lanza para que BullMQ reintente', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest.spyOn(service, 'sendToAeat').mockResolvedValueOnce({
      status: 'error',
      message: 'AEAT timeout',
    } satisfies SendInvoiceResult);

    const job = {
      name: JOB_VERIFACTU_SEND,
      data: { invoiceId: 'inv-3', tenantId: 'tenant-3' },
    } as unknown as Job<{ invoiceId: string; tenantId: string }>;

    await expect(processor.process(job)).rejects.toThrow(/AEAT timeout/);
    spy.mockRestore();
  });

  it('worker handler ignora jobs con nombre distinto a send-to-aeat', async () => {
    const service = app.get(VerifactuService);
    const processor = app.get(VerifactuProcessor);
    const spy = jest.spyOn(service, 'sendToAeat');

    const job = {
      name: 'unknown-job',
      data: { invoiceId: 'inv-x', tenantId: 'tenant-x' },
    } as unknown as Job<{ invoiceId: string; tenantId: string }>;

    await expect(processor.process(job)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('issue de una invoice encola un job send-to-aeat en la cola verifactu', async () => {
    const owner = await registerVerifiedUser(app, 'verif-issue-enq');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 60,
    });
    // Espia el queue.add antes de issue.
    const invoicesService = app.get(InvoicesService);
    // @ts-expect-error acceso al campo privado para inspeccion en test.
    const queue = invoicesService.verifactuQueue;
    const addSpy = jest.spyOn(queue, 'add');

    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);

    expect(addSpy).toHaveBeenCalledWith(
      JOB_VERIFACTU_SEND,
      expect.objectContaining({ invoiceId: id, tenantId: owner.tenantId }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      }),
    );
    expect(QUEUE_VERIFACTU).toBe('verifactu');
    addSpy.mockRestore();
  });
});
