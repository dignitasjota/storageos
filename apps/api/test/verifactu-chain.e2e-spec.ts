import request from 'supertest';

import { VerifactuService } from '../src/modules/billing/verifactu.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Cadena de huellas Veri*Factu por emisor (no por serie), con la huella
 * oficial y la fecha-hora de generación guardada al emitir.
 */
describe('Veri*Factu: cadena por emisor (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaAdminService;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    admin = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('dos series encadenan en el mismo emisor y la huella es verificable', async () => {
    const owner = await registerVerifiedUser(app, 'vfchain');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const customerId = await createCustomer(app, owner.accessToken);

    const first = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${first}/issue`).set(auth).expect(200);

    // Segunda serie: antes empezaba su propia cadena.
    const series = await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'B', name: 'Serie B', prefix: 'B', isDefault: false })
      .expect(201);
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        seriesId: series.body.id,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);

    const a = await admin.invoice.findUniqueOrThrow({ where: { id: first } });
    const b = await admin.invoice.findUniqueOrThrow({ where: { id: draft.body.id } });
    expect(a.seriesId).not.toBe(b.seriesId);
    expect(a.previousInvoiceId).toBeNull();
    expect(b.previousInvoiceId).toBe(a.id);
    expect(b.chainSeq).toBe(a.chainSeq! + 1);
    expect(b.previousHash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9A-F]{64}$/);
    expect(b.aeatRecordTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    // La huella se recalcula con los datos guardados.
    const verifactu = app.get(VerifactuService);
    expect(verifactu.verifyHash({ tenantTaxId: 'PENDIENTE', invoice: b })).toBe(true);
    expect(
      verifactu.verifyHash({ tenantTaxId: 'PENDIENTE', invoice: { ...b, total: b.taxAmount } }),
    ).toBe(false);
  });

  it('no se reenvía a la AEAT una factura ya aceptada', async () => {
    const owner = await registerVerifiedUser(app, 'vfresend');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const customerId = await createCustomer(app, owner.accessToken);
    const id = await createDraftInvoice(app, owner.accessToken, customerId);
    await request(app.getHttpServer()).post(`/invoices/${id}/issue`).set(auth).expect(200);
    await admin.invoice.update({ where: { id }, data: { aeatStatus: 'accepted' } });
    const res = await request(app.getHttpServer())
      .post(`/billing/invoices/${id}/resend-aeat`)
      .set(auth)
      .expect(400);
    expect(res.body.code).toBe('already_accepted');
  });

  it('en envío real exige el NIF del emisor y un NIF válido del cliente', async () => {
    const owner = await registerVerifiedUser(app, 'vfnif');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const spy = jest.spyOn(app.get(VerifactuService), 'realMode', 'get').mockReturnValue(true);
    try {
      const noDoc = await createCustomer(app, owner.accessToken);
      const id = await createDraftInvoice(app, owner.accessToken, noDoc);
      const r1 = await http().post(`/invoices/${id}/issue`).set(auth).expect(400);
      expect(r1.body.code).toBe('tenant_tax_id_required');

      const tenant = await admin.tenant.findUniqueOrThrow({ where: { slug: owner.slug } });
      await admin.tenant.update({ where: { id: tenant.id }, data: { taxId: 'B12345674' } });
      await admin.customer.update({ where: { id: noDoc }, data: { documentNumber: null } });
      const r2 = await http().post(`/invoices/${id}/issue`).set(auth).expect(400);
      expect(r2.body.code).toBe('customer_tax_id_required');

      await admin.customer.update({
        where: { id: noDoc },
        data: { documentNumber: '12345678Z', country: 'ES' },
      });
      // Sin certificado vigente no se emite (se quedaría sin registrar).
      const r3 = await http().post(`/invoices/${id}/issue`).set(auth).expect(400);
      expect(r3.body.code).toBe('aeat_certificate_required');
      const user = await admin.user.findFirstOrThrow({ where: { tenantId: tenant.id } });
      await admin.tenantAeatCredential.create({
        data: {
          tenantId: tenant.id,
          certP12Encrypted: Buffer.from('x'),
          certPasswordEncrypted: 'x',
          certCommonName: 'TEST',
          certNif: 'B12345674',
          certIssuer: 'TEST',
          certValidFrom: new Date(Date.now() - 86_400_000),
          certValidTo: new Date(Date.now() + 365 * 86_400_000),
          uploadedById: user.id,
        },
      });
      await http().post(`/invoices/${id}/issue`).set(auth).expect(200);
    } finally {
      spy.mockRestore();
    }
  });
});
