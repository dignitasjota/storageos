import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantFeatureOverride } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Plan Administrador: las facturas de los contratos de un propietario las
 * emite él — su serie, su cadena Veri*Factu y sus datos en el registro.
 */
describe('Propietario como emisor (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    await cleanupTestTenants();
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    await cleanupTestTenants();
  });

  it('serie, cadena y recargo propios del propietario', async () => {
    const user = await registerVerifiedUser(app, 'ownissuer');
    const auth = { Authorization: `Bearer ${user.accessToken}` };
    const http = () => request(app.getHttpServer());
    const tenantSeriesId = await ensureDefaultSeries(app, user.accessToken);
    await setTenantFeatureOverride(user.slug, 'multi_owner', true);
    await http()
      .patch('/settings/tenant/billing')
      .set(auth)
      .send({ lateFeeEnabled: true, lateFeeType: 'percentage', lateFeeValue: 5 })
      .expect(200);

    const { facilityId, unitIds } = await createFacilityWithUnits(app, user.accessToken, {
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const owner = await http()
      .post('/owners')
      .set(auth)
      .send({ legalName: 'Inversiones Pérez SL', taxId: 'B12345674' })
      .expect(201);
    await http()
      .patch(`/facilities/${facilityId}`)
      .set(auth)
      .send({ ownerId: owner.body.id })
      .expect(200);
    const customerId = await createCustomer(app, user.accessToken);
    const contract = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId: unitIds[0],
        startDate: '2026-01-01',
        priceMonthly: 100,
        depositAmount: 0,
      })
      .expect(201);

    // Factura del contrato (aunque se pida la serie por defecto del tenant).
    const draft = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        seriesId: tenantSeriesId,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(201);
    expect(draft.body).toMatchObject({ ownerId: owner.body.id, ownerName: 'Inversiones Pérez SL' });
    const issued = await http().post(`/invoices/${draft.body.id}/issue`).set(auth).expect(200);
    expect(issued.body.invoiceNumber).toMatch(/^P1\//);

    // Factura del propio tenant: su serie y su propia cadena.
    const own = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        items: [{ description: 'Candado', quantity: 1, unitPrice: 10, taxRate: 21 }],
      })
      .expect(201);
    expect(own.body.ownerId).toBeNull();
    const ownIssued = await http().post(`/invoices/${own.body.id}/issue`).set(auth).expect(200);
    expect(ownIssued.body.invoiceNumber).not.toMatch(/^P1\//);

    const rows = await admin.invoice.findMany({
      where: { id: { in: [draft.body.id, own.body.id] } },
      select: { id: true, chainSeq: true, previousInvoiceId: true, ownerId: true },
    });
    for (const r of rows) {
      expect(r.chainSeq).toBe(1);
      expect(r.previousInvoiceId).toBeNull();
    }

    // Una serie de tu empresa (no la por defecto) no vale para un propietario.
    const other = await http()
      .post('/invoice-series')
      .set(auth)
      .send({ code: 'B', name: 'Otra', prefix: 'FB', yearScope: true, isDefault: false })
      .expect(201);
    await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId: contract.body.id,
        seriesId: other.body.id,
        items: [{ description: 'Alquiler', quantity: 1, unitPrice: 100, taxRate: 21 }],
      })
      .expect(400);

    // El recargo y la rectificativa también los emite el propietario.
    await admin.invoice.update({ where: { id: draft.body.id }, data: { status: 'overdue' } });
    const fee = await http().post(`/invoices/${draft.body.id}/late-fee`).set(auth).expect(200);
    expect(fee.body.ownerId).toBe(owner.body.id);
    expect(fee.body.invoiceNumber).toMatch(/^P1\//);
    const second = await admin.invoice.findUniqueOrThrow({
      where: { id: fee.body.id },
      select: { chainSeq: true, previousInvoiceId: true },
    });
    expect(second).toEqual({ chainSeq: 2, previousInvoiceId: draft.body.id });

    const rect = await http()
      .post(`/invoices/${draft.body.id}/rectify`)
      .set(auth)
      .send({
        reason: 'Error en el precio',
        rectificationType: 'R4',
        items: [{ description: 'Ajuste', quantity: 1, unitPrice: -10, taxRate: 21 }],
      });
    expect(rect.status).toBe(201);
    expect(rect.body.ownerId).toBe(owner.body.id);
    const rectIssued = await http().post(`/invoices/${rect.body.id}/issue`).set(auth).expect(200);
    expect(rectIssued.body.invoiceNumber).toMatch(/^RP1\//);
  });
});
