import ExcelJS from 'exceljs';
import request from 'supertest';

import { InvoicesService } from '../src/modules/billing/invoices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice, ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Exportación para la asesoría de un tenant: facturas por tipo de IVA, cobros
 * (sin las fianzas) y la hoja de fianzas (recibida, devuelta y retenida).
 */
describe('Exportación para la asesoría del tenant (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('facturas, cobros y fianzas; Excel con tres hojas y CSV de fianzas', async () => {
    const owner = await registerVerifiedUser(app, 'tenantacc');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);

    // Factura de 100 € + 21 % cobrada en efectivo.
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId, {
      unitPrice: 100,
    });
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await http()
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    // Contrato con fianza de 100 €: justificante cobrado y liquidación (70 devueltos).
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId: unitIds[0],
      startDate: '2026-05-01',
      priceMonthly: 60,
      depositAmount: 100,
    });
    expect(contract.status).toBe(201);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).expect(200);
    const receipt = await app.get(InvoicesService).createDepositReceipt({
      tenantId: owner.tenantId,
      userId: null,
      contractId: contract.body.id,
      customerId,
      contractNumber: contract.body.contractNumber,
      amount: 100,
      dueDate: null,
      bundledWithInvoiceId: null,
    });
    await http()
      .post(`/invoices/${receipt.id}/mark-paid`)
      .set(auth)
      .send({ amount: 100, methodType: 'bank_transfer' })
      .expect(200);
    await http()
      .post(`/contracts/${contract.body.id}/settle-deposit`)
      .set(auth)
      .send({ returnedAmount: 70, retentionReason: 'Daños en la puerta' })
      .expect(200);

    const today = new Date().toISOString().slice(0, 10);
    const res = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}`)
      .set(auth)
      .expect(200);
    const invoiceRows = res.body.invoices as { base: number; vat: number }[];
    expect(invoiceRows).toHaveLength(1);
    expect(invoiceRows[0]).toMatchObject({ base: 100, vat: 21 });
    // Los cobros no incluyen la fianza (no es un ingreso).
    expect(res.body.payments).toEqual([expect.objectContaining({ amount: 121 })]);
    const deposits = res.body.deposits as { movement: string; amount: number }[];
    expect(deposits.map((d) => [d.movement, d.amount]).sort()).toEqual(
      [
        ['received', 100],
        ['retained', 30],
        ['returned', -70],
      ].sort(),
    );
    // El cliente de prueba no tiene domicilio → aviso.
    expect(res.body.warnings.length).toBeGreaterThanOrEqual(1);

    // Excel con tres hojas y sin la columna «Actividad».
    const xlsx = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}&format=xlsx`)
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Facturas', 'Cobros', 'Fianzas']);
    expect(wb.getWorksheet('Facturas')!.getRow(1).getCell(1).value).toBe('Nº factura');
    expect(wb.getWorksheet('Fianzas')!.rowCount).toBe(4);

    const csv = await http()
      .get(`/fiscal/accountant-export?from=${today}&to=${today}&format=csv&kind=deposits`)
      .set(auth)
      .expect(200);
    expect(csv.text).toContain('Fianza retenida');
    expect(csv.text).toContain('Daños en la puerta');

    await http().get('/fiscal/accountant-export?from=x&to=y').set(auth).expect(400);
  });
});
