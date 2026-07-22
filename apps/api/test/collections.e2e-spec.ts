import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CollectionsService } from '../src/modules/collections/collections.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

/**
 * Expedientes de impago (overlock → requerimiento → disposición). Ciclo
 * completo de la máquina de estados + cierre automático por pago + guards +
 * gating por feature.
 */
describe('Collections / expedientes de impago (e2e)', () => {
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

  /** Crea contrato + factura emitida con deuda; devuelve ids. */
  async function seedContractWithDebt(accessToken: string) {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, accessToken, {
      facilityName: 'Local Impago',
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const unitId = unitIds[0]!;
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Moro', lastName: 'So', country: 'ES' });
    const customerId = customer.body.id as string;
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: new Date().toISOString().slice(0, 10),
        priceMonthly: 100,
        billingCycle: 'monthly',
        cancellationNoticeDays: 30,
      });
    expect(contract.status).toBe(201);
    const contractId = contract.body.id as string;

    await ensureDefaultSeries(app, accessToken);
    const invoice = await request(app.getHttpServer())
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
      });
    expect(invoice.status).toBe(201);
    const invoiceId = invoice.body.id as string;
    await request(app.getHttpServer()).post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);

    return { customerId, contractId, invoiceId };
  }

  it('gating: un tenant sin la feature no accede a collections', async () => {
    const owner = await registerVerifiedUser(app, 'coll-free');
    await setTenantPlan(owner.slug, 'free');
    await request(app.getHttpServer())
      .get('/collections')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(403);
  });

  it('ciclo completo: abrir → overlock → requerimiento → disposición', async () => {
    const owner = await registerVerifiedUser(app, 'coll-cycle');
    await setTenantPlan(owner.slug, 'starter'); // starter incluye collections
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { contractId } = await seedContractWithDebt(owner.accessToken);

    // Abrir expediente.
    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    expect(open.status).toBe(201);
    expect(open.body.status).toBe('open');
    expect(open.body.debtCents).toBe(12100); // 100 + 21% IVA
    const caseId = open.body.id as string;

    // Abrir un 2º expediente del mismo contrato → 409 (índice único parcial).
    const dup = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    expect(dup.status).toBeGreaterThanOrEqual(400);

    // Transición inválida: no se puede ir a disposición directamente.
    await request(app.getHttpServer())
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'auction_notarial' })
      .expect(400);

    // overlock → final_notice → resolution_pending → disposal → closed_disposed.
    const over = await request(app.getHttpServer())
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ notes: 'Candado colocado' });
    expect(over.body.status).toBe('overlocked');
    expect(over.body.overlockedAt).not.toBeNull();

    const notice = await request(app.getHttpServer())
      .post(`/collections/${caseId}/notice`)
      .set(auth)
      .send({ noticeDays: 15 });
    expect(notice.body.status).toBe('final_notice');
    expect(notice.body.finalNoticeDeadline).not.toBeNull();

    await request(app.getHttpServer())
      .post(`/collections/${caseId}/resolution-pending`)
      .set(auth)
      .expect(200);

    const disp = await request(app.getHttpServer())
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'auction_notarial' });
    expect(disp.body.status).toBe('disposal');

    const done = await request(app.getHttpServer())
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 5000 });
    expect(done.body.status).toBe('closed_disposed');
    expect(done.body.closedAt).not.toBeNull();

    // El detalle tiene el timeline completo.
    const detail = await request(app.getHttpServer()).get(`/collections/${caseId}`).set(auth);
    const types = (detail.body.events as { eventType: string }[]).map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining(['opened', 'overlock_placed', 'notice_sent', 'disposal_done']),
    );
  });

  it('cierre automático al pagar la deuda', async () => {
    const owner = await registerVerifiedUser(app, 'coll-paid');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { customerId, contractId, invoiceId } = await seedContractWithDebt(owner.accessToken);
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    const tenantId = me.body.tenant.id as string;

    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;
    await request(app.getHttpServer()).post(`/collections/${caseId}/overlock`).set(auth).send({});

    // Pagar la factura → la deuda del contrato baja a 0.
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);

    // El cierre lo dispara el listener invoice_paid; lo invocamos explícito para
    // no depender del timing del EventEmitter en el test.
    await app.get(CollectionsService).onInvoicePaid(tenantId, customerId);

    const detail = await request(app.getHttpServer()).get(`/collections/${caseId}`).set(auth);
    expect(detail.body.status).toBe('closed_paid');
    expect(detail.body.debtCents).toBe(0);
  });

  it('apertura manual exige deuda (400 si el contrato no debe nada)', async () => {
    const owner = await registerVerifiedUser(app, 'coll-nodebt');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Sano',
      unitsCount: 1,
    });
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(auth)
      .send({ customerType: 'individual', firstName: 'Al', lastName: 'Día', country: 'ES' });
    const contract = await request(app.getHttpServer())
      .post('/contracts')
      .set(auth)
      .send({
        customerId: customer.body.id,
        unitId: unitIds[0],
        startDate: new Date().toISOString().slice(0, 10),
        priceMonthly: 100,
        billingCycle: 'monthly',
        cancellationNoticeDays: 30,
      });
    const res = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId: contract.body.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_debt');
  });

  it('liquidación fina: la fianza + disposición saldan la factura por antigüedad', async () => {
    const owner = await registerVerifiedUser(app, 'coll-settle');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { contractId, invoiceId } = await seedContractWithDebt(owner.accessToken); // deuda 121€

    // Fijamos una fianza retenida de 50€ en el contrato (como si se firmó con fianza).
    await admin.contract.update({
      where: { id: contractId },
      data: { depositAmount: 50, depositStatus: 'held' },
    });

    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;
    for (const step of ['overlock', 'notice', 'resolution-pending', 'disposal'] as const) {
      const body =
        step === 'disposal' ? { disposalType: 'auction_notarial' } : step === 'notice' ? {} : {};
      await request(app.getHttpServer()).post(`/collections/${caseId}/${step}`).set(auth).send(body);
    }

    // Cierre con 30€ de producto de la disposición + aplicar fianza (50€).
    const done = await request(app.getHttpServer())
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 3000, applyDeposit: true });
    expect(done.body.status).toBe('closed_disposed');

    // El evento disposal_done lleva el desglose de la liquidación.
    const detail = await request(app.getHttpServer()).get(`/collections/${caseId}`).set(auth);
    const dispEvent = (detail.body.events as { eventType: string; payload: unknown }[]).find(
      (e) => e.eventType === 'disposal_done',
    );
    const settlement = (dispEvent?.payload as { settlement?: Record<string, number> })?.settlement;
    expect(settlement).toBeTruthy();
    expect(settlement!.debtBeforeCents).toBe(12100);
    expect(settlement!.depositAppliedCents).toBe(5000);
    expect(settlement!.proceedsAppliedCents).toBe(3000);
    expect(settlement!.debtAfterCents).toBe(4100); // 12100 - 5000 - 3000
    expect(settlement!.invoicesSettled).toBe(1);

    // La factura quedó con 80€ abonados (50 fianza + 30 producto).
    const inv = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(inv.body.amountPaid).toBe(80);
    expect(inv.body.status).not.toBe('paid'); // sigue con saldo pendiente

    // La fianza quedó liquidada (consumida entera → returned, 0 devuelto).
    const contract = await admin.contract.findUnique({ where: { id: contractId } });
    expect(contract?.depositStatus).toBe('returned');
    expect(Number(contract?.depositReturnedAmount)).toBe(0);
    expect(contract?.depositSettledAt).not.toBeNull();
  });

  // Nota: la generación REAL del PDF usa Puppeteer (`await import('puppeteer')`),
  // que no funciona bajo ts-jest (CommonJS) — como el resto de PDFs del proyecto,
  // no se ejercita en e2e. El render (HTML) se cubre en el unit
  // `requirement-template.spec`. Aquí solo verificamos el gating del endpoint.
  it('el requerimiento (PDF) exige la feature collections y autenticación', async () => {
    const owner = await registerVerifiedUser(app, 'coll-req-gate');
    await setTenantPlan(owner.slug, 'free'); // free NO incluye collections
    const fakeCaseId = '00000000-0000-0000-0000-000000000000';

    // Sin la feature → 403 (el FeatureGuard corta antes de tocar Puppeteer).
    await request(app.getHttpServer())
      .post(`/collections/${fakeCaseId}/requirement-pdf`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(403);

    // Sin autenticación → 401.
    await request(app.getHttpServer())
      .post(`/collections/${fakeCaseId}/requirement-pdf`)
      .expect(401);
  });
});
