import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Prorrateo del primer mes + NO doble facturación (bug de dinero).
 *
 * La 1ª factura del alta cubre [alta, fin de mes natural] con el alquiler
 * prorrateado; la recurrente factura por mes natural. Antes el dedup exigía
 * coincidencia EXACTA de periodo → nunca casaba → el primer mes se cobraba dos
 * veces. Ahora el move-in prorratea a fin de mes y la recurrente deduplica por
 * SOLAPAMIENTO, así que el periodo del alta no se re-factura.
 */
describe('Facturación: prorrateo del 1er mes + sin doble cobro (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  it('alta a mitad de mes → alquiler prorrateado + la recurrente del mismo mes NO duplica', async () => {
    const owner = await registerVerifiedUser(app, 'proration');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    // Precio 31 € → prorrateo limpio: 15-mar..31-mar = 17 días de 31 → 17,00 €.
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1, pricePerUnit: 31 });

    // Reserva pública con alta el 15 de marzo.
    const avail = await request(app.getHttpServer()).get(
      `/public/move-in/book/${owner.slug}/availability`,
    );
    const facility = avail.body.facilities[0];
    const booking = await request(app.getHttpServer())
      .post(`/public/move-in/book/${owner.slug}`)
      .send({
        facilityId: facility.id,
        unitTypeId: facility.unitTypes[0].id,
        startDate: '2026-03-15',
        customer: { firstName: 'Ana', lastName: 'Ruiz', email: `prorr-${Date.now()}@e2e.local` },
      });
    expect(booking.status).toBe(201);
    const contractId = booking.body.contractId as string;

    await request(app.getHttpServer())
      .post(`/public/move-in/sign/${booking.body.signingToken}`)
      .send({ signerName: 'Ana Ruiz', method: 'typed', typedSignature: 'Ana Ruiz', accept: true })
      .expect(201);

    // 1ª factura: alquiler prorrateado (17 €) y periodo [2026-03-15, 2026-03-31].
    const list = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    const firstId = (list.body.items ?? list.body)[0].id as string;
    const first = await request(app.getHttpServer()).get(`/invoices/${firstId}`).set(auth);
    const rent = (first.body.items as { description: string; unitPrice: number }[]).find((i) =>
      i.description.toLowerCase().includes('alquiler'),
    );
    expect(rent).toBeDefined();
    expect(rent!.unitPrice).toBe(17);
    expect(first.body.items[0].periodStart.slice(0, 10)).toBe('2026-03-15');
    expect(first.body.items[0].periodEnd.slice(0, 10)).toBe('2026-03-31');

    // Recurrente de MARZO (mes natural) → NO debe crear otra factura (solapa).
    const billing = app.get(BillingJobsService);
    const marchRun = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
    });
    const afterMarch = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    expect((afterMarch.body.items ?? afterMarch.body).length).toBe(1);

    // Recurrente de ABRIL → SÍ crea la factura del mes completo (no solapa).
    const aprRun = await billing.processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-04-01',
      periodEnd: '2026-04-30',
    });
    expect(aprRun.created).toBeGreaterThanOrEqual(1);
    const afterApril = await request(app.getHttpServer())
      .get(`/invoices?contractId=${contractId}`)
      .set(auth);
    expect((afterApril.body.items ?? afterApril.body).length).toBe(2);

    // (marchRun se referencia para dejar claro que la recurrente corrió sin crear nada)
    expect(marchRun.created).toBe(0);
  });
});
