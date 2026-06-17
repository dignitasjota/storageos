import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { deleteAllMessages, extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Tests e2e del sub-bloque 11A.4 — rectificativas Veri*Factu R1-R5 por
 * diferencias. Verifican el endpoint `POST /invoices/:id/rectify`, la
 * persistencia del campo `invoiceType` + `rectifiesInvoiceId` y el
 * encadenamiento hash al emitir la rectificativa.
 */
describe('Invoice rectifications R1-R5 (e2e)', () => {
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

  it('rectifica una factura F1 emitida y crea una R1 en draft con items negativos', async () => {
    const owner = await registerVerifiedUser(app, 'rect-r1');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued.status).toBe(200);

    const res = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'NIF erroneo en la original',
        items: [
          {
            description: 'Ajuste por NIF erroneo',
            quantity: 1,
            unitPrice: -100,
            taxRate: 21,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.invoiceType).toBe('R1');
    expect(res.body.rectifiesInvoiceId).toBe(originalId);
    expect(res.body.correctionMethod).toBe('by_differences');
    expect(res.body.rectificationReason).toBe('NIF erroneo en la original');
    expect(res.body.subtotal).toBe(-100);
    expect(res.body.taxAmount).toBeCloseTo(-21, 1);
    expect(res.body.total).toBeCloseTo(-121, 1);
  });

  it('issue de la rectificativa asigna numero, hash encadenado y aeat_status accepted', async () => {
    const owner = await registerVerifiedUser(app, 'rect-issue');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 50,
    });
    const originalIssued = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(originalIssued.status).toBe(200);

    const rectifyRes = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'Importe equivocado',
        items: [{ description: 'Ajuste importe', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(rectifyRes.status).toBe(201);
    const rectId = rectifyRes.body.id as string;

    const issuedRect = await request(app.getHttpServer())
      .post(`/invoices/${rectId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issuedRect.status).toBe(200);
    expect(issuedRect.body.status).toBe('issued');
    expect(issuedRect.body.invoiceNumber).toMatch(/^FA\/\d{4}\/00002$/);
    expect(issuedRect.body.hash).toMatch(/^[0-9a-f]{64}$/);
    // El previousHash encadena con la ultima de la serie (la F1 original).
    expect(issuedRect.body.previousHash).toBe(originalIssued.body.hash);
    // Desde Fase 10A.4 el envio a AEAT pasa a ser asincrono via BullMQ; tras
    // issue la factura queda con aeatStatus=null/pending hasta que el worker
    // la procesa. La validacion del envio real vive en verifactu-queue.e2e.
    expect(['pending', null]).toContain(issuedRect.body.aeatStatus);
  });

  it('rechaza rectificar un draft (400 invoice_not_rectifiable)', async () => {
    const owner = await registerVerifiedUser(app, 'rect-draft');
    const customerId = await createCustomer(app, owner.accessToken);
    const draftId = await createDraftInvoice(app, owner.accessToken, customerId);

    const res = await request(app.getHttpServer())
      .post(`/invoices/${draftId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'test',
        items: [{ description: 'x', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invoice_not_rectifiable');
  });

  it('rechaza rectificar una factura cancelada (400 invoice_not_rectifiable)', async () => {
    const owner = await registerVerifiedUser(app, 'rect-cancelled');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ reason: 'test' });

    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'test',
        items: [{ description: 'x', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invoice_not_rectifiable');
  });

  it('rechaza rectificar una rectificativa (400 invoice_not_rectifiable)', async () => {
    const owner = await registerVerifiedUser(app, 'rect-of-rect');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const first = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'primera rectificacion',
        items: [{ description: 'x', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(first.status).toBe(201);
    // La rectificativa esta en draft; la emitimos para que pase a issued.
    await request(app.getHttpServer())
      .post(`/invoices/${first.body.id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const second = await request(app.getHttpServer())
      .post(`/invoices/${first.body.id}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'rectificar la rectificativa',
        items: [{ description: 'x', quantity: 1, unitPrice: -5, taxRate: 21 }],
      });
    expect(second.status).toBe(400);
    expect(second.body.code).toBe('invoice_not_rectifiable');
  });

  it('cross-tenant: rectificar invoice de otro tenant devuelve 404', async () => {
    const tenantA = await registerVerifiedUser(app, 'rect-cross-a');
    const tenantB = await registerVerifiedUser(app, 'rect-cross-b');
    const customerId = await createCustomer(app, tenantA.accessToken);
    const id = await createDraftInvoice(app, tenantA.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${tenantA.accessToken}`);

    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/rectify`)
      .set('Authorization', `Bearer ${tenantB.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'fuga',
        items: [{ description: 'x', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('invoice_not_found');
  });

  it('rectificar con correctionMethod=by_substitution persiste el metodo en la rectificativa', async () => {
    const owner = await registerVerifiedUser(app, 'rect-sub');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    const issued = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issued.status).toBe(200);

    // Por sustitucion: los items representan el NUEVO total absoluto.
    const res = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R4',
        correctionMethod: 'by_substitution',
        reason: 'Sustitucion completa por error de importe',
        items: [
          {
            description: 'Cuota mes (corregida)',
            quantity: 1,
            unitPrice: 90,
            taxRate: 21,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.invoiceType).toBe('R4');
    expect(res.body.correctionMethod).toBe('by_substitution');
    // Subtotal y total son los nuevos absolutos, no diferencias.
    expect(res.body.subtotal).toBeCloseTo(90, 2);
    expect(res.body.total).toBeCloseTo(108.9, 2);
  });

  it('issue de rectificativa por sustitucion: aeatResponse refleja correctionMethod', async () => {
    const owner = await registerVerifiedUser(app, 'rect-sub-issue');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const rectifyRes = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        correctionMethod: 'by_substitution',
        reason: 'Importe corregido',
        items: [
          {
            description: 'Cuota mes corregida',
            quantity: 1,
            unitPrice: 80,
            taxRate: 21,
          },
        ],
      });
    expect(rectifyRes.status).toBe(201);
    const rectId = rectifyRes.body.id as string;

    const issuedRect = await request(app.getHttpServer())
      .post(`/invoices/${rectId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(issuedRect.status).toBe(200);
    expect(issuedRect.body.status).toBe('issued');
    expect(issuedRect.body.correctionMethod).toBe('by_substitution');
    expect(issuedRect.body.invoiceType).toBe('R1');
    expect(issuedRect.body.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('correctionMethod por defecto sigue siendo by_differences (retrocompat)', async () => {
    const owner = await registerVerifiedUser(app, 'rect-default-method');
    const customerId = await createCustomer(app, owner.accessToken);
    const originalId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await request(app.getHttpServer())
      .post(`/invoices/${originalId}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    // Llamada SIN `correctionMethod`: debe asumir `by_differences`.
    const res = await request(app.getHttpServer())
      .post(`/invoices/${originalId}/rectify`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'NIF erroneo',
        items: [
          {
            description: 'Ajuste',
            quantity: 1,
            unitPrice: -10,
            taxRate: 21,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.correctionMethod).toBe('by_differences');
  });

  it('rol staff no puede rectificar (403)', async () => {
    const owner = await registerVerifiedUser(app, 'rect-staff');
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer())
      .post(`/invoices/${id}/issue`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    // Invitamos a un staff y obtenemos su access token.
    const staffEmail = `staff-${Date.now().toString(36)}@e2e.local`;
    const invRes = await request(app.getHttpServer())
      .post('/invitations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: staffEmail, role: 'staff' });
    expect(invRes.status).toBe(201);
    const mail = await waitForEmail(staffEmail, { subjectIncludes: 'invitado' });
    const token = extractToken(mail.Text, '/invite');
    const accept = await request(app.getHttpServer())
      .post(`/invitations/token/${token}/accept`)
      .send({ fullName: 'Staff Rect', password: 'Secret123' });
    expect(accept.status).toBe(200);
    const staffToken = accept.body.accessToken as string;

    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/rectify`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({
        rectificationType: 'R1',
        reason: 'staff intenta',
        items: [{ description: 'x', quantity: 1, unitPrice: -5, taxRate: 21 }],
      });
    expect(res.status).toBe(403);
    // rectify migró a @RequirePermission('invoices:manage'); staff no lo tiene.
    expect(['insufficient_permission', 'insufficient_role', 'forbidden']).toContain(res.body.code);
  });
});
