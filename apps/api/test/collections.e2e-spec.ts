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

const DAY = 86_400_000;

/**
 * Expedientes de impago según la condición 12 del contrato: candado (tras
 * avisarle) → requerimiento → plazo vencido → contrato resuelto → traslado con
 * inventario y custodia → disposición por un cauce legal. Cierre automático
 * por pago, liquidación de la fianza y gating por feature.
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

  /** Contrato firmado + factura de 121 € vencida hace 20 días. */
  async function seedContractWithDebt(accessToken: string) {
    const auth = { Authorization: `Bearer ${accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, accessToken, {
      facilityName: 'Local Impago',
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const unitId = unitIds[0]!;
    const customer = await request(app.getHttpServer()).post('/customers').set(auth).send({
      customerType: 'individual',
      firstName: 'Moro',
      lastName: 'So',
      country: 'ES',
      address: 'Calle Mayor 1',
      city: 'Madrid',
      postalCode: '28001',
    });
    const customerId = customer.body.id as string;
    const contract = await request(app.getHttpServer()).post('/contracts').set(auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      billingCycle: 'monthly',
      cancellationNoticeDays: 30,
    });
    expect(contract.status).toBe(201);
    const contractId = contract.body.id as string;
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/sign`)
      .set(auth)
      .send({})
      .expect(200);

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
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(Date.now() - 20 * DAY), status: 'overdue' },
    });

    return { customerId, contractId, invoiceId, unitId };
  }

  /** Sube una evidencia sin pasar por MinIO (el registro real comprueba los bytes). */
  async function addFile(caseId: string, kind: string) {
    const row = await admin.delinquencyCase.findUniqueOrThrow({ where: { id: caseId } });
    await admin.delinquencyCaseFile.create({
      data: {
        tenantId: row.tenantId,
        caseId,
        kind,
        objectKey: `${row.tenantId}/collections/${caseId}/${kind}/x.jpg`,
        contentType: 'image/jpeg',
      },
    });
  }

  /** Lleva el expediente abierto hasta «en disposición» (cauce: resolución judicial). */
  async function advanceToDisposal(auth: Record<string, string>, caseId: string) {
    const http = () => request(app.getHttpServer());
    await http()
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'Llamada al inquilino' })
      .expect(200);
    await http().post(`/collections/${caseId}/notice`).set(auth).send({}).expect(200);
    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { finalNoticeDeadline: new Date(Date.now() - DAY) },
    });
    await http().post(`/collections/${caseId}/resolution-pending`).set(auth).expect(200);
    await http().post(`/collections/${caseId}/resolve-contract`).set(auth).send({}).expect(200);
    await addFile(caseId, 'inventory');
    await http()
      .post(`/collections/${caseId}/move-goods`)
      .set(auth)
      .send({ custodyLocation: 'Nave 3, Polígono Norte' })
      .expect(200);
    await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'court_order' })
      .expect(200);
    await addFile(caseId, 'disposal_act');
  }

  it('gating: un tenant sin la feature no accede a collections', async () => {
    const owner = await registerVerifiedUser(app, 'coll-free');
    await setTenantPlan(owner.slug, 'free');
    await request(app.getHttpServer())
      .get('/collections')
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(403);
  });

  it('ciclo completo según la condición 12, con sus compuertas', async () => {
    const owner = await registerVerifiedUser(app, 'coll-cycle');
    await setTenantPlan(owner.slug, 'starter'); // starter incluye collections
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const { contractId, unitId } = await seedContractWithDebt(owner.accessToken);

    const open = await http().post('/collections').set(auth).send({ contractId });
    expect(open.status).toBe(201);
    expect(open.body.status).toBe('open');
    expect(open.body.debtCents).toBe(12100); // 100 + 21% IVA
    const caseId = open.body.id as string;

    // Un 2º expediente del mismo contrato → 409.
    const dup = await http().post('/collections').set(auth).send({ contractId });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('case_already_open');

    // No se salta pasos ni se usan cauces que ya no existen.
    await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'court_order' })
      .expect(400);
    await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'auction_notarial' })
      .expect(400);

    // Candado: hay que haberle avisado antes.
    const noNotice = await http().post(`/collections/${caseId}/overlock`).set(auth).send({});
    expect(noNotice.status).toBe(400);
    expect(noNotice.body.code).toBe('notice_before_overlock_required');
    const over = await http()
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'Llamada el día 3' });
    expect(over.status).toBe(200);
    expect(over.body.status).toBe('overlocked');
    expect(over.body.overlockedAt).not.toBeNull();

    // Requerimiento: plazo mínimo de 15 días.
    await http()
      .post(`/collections/${caseId}/notice`)
      .set(auth)
      .send({ noticeDays: 10 })
      .expect(400);
    const notice = await http()
      .post(`/collections/${caseId}/notice`)
      .set(auth)
      .send({
        noticeDays: 15,
        tracking: 'BF-123',
        sentAt: new Date(Date.now() - 3 * DAY).toISOString(),
      });
    expect(notice.status).toBe(200);
    expect(notice.body.status).toBe('final_notice');
    expect(notice.body.noticeDays).toBe(15);
    expect(notice.body.noticeTracking).toBe('BF-123');

    // El plazo no ha vencido: aún no se puede seguir.
    const early = await http().post(`/collections/${caseId}/resolution-pending`).set(auth);
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('deadline_not_reached');

    // Recepción del burofax: no antes del envío; el plazo cuenta desde la entrega.
    await http()
      .post(`/collections/${caseId}/notice-received`)
      .set(auth)
      .send({ receivedAt: new Date(Date.now() - 4 * DAY).toISOString() })
      .expect(400);
    const receivedAt = new Date(Date.now() - 2 * DAY).toISOString();
    const received = await http()
      .post(`/collections/${caseId}/notice-received`)
      .set(auth)
      .send({ receivedAt });
    expect(received.status).toBe(200);
    expect(received.body.noticeReceivedAt).toBe(receivedAt);
    expect(new Date(received.body.finalNoticeDeadline).getTime()).toBe(
      new Date(receivedAt).getTime() + 15 * DAY,
    );

    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { finalNoticeDeadline: new Date(Date.now() - DAY) },
    });
    await http().post(`/collections/${caseId}/resolution-pending`).set(auth).expect(200);

    // Contrato resuelto: se termina y el trastero queda bloqueado con los bienes.
    const resolved = await http()
      .post(`/collections/${caseId}/resolve-contract`)
      .set(auth)
      .send({});
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('contract_resolved');
    const contract = await admin.contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.status).toBe('ended');
    const blocked = await admin.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(blocked.status).toBe('blocked');
    expect(blocked.outOfServiceReason).toContain('Impago');

    // Traslado: exige el inventario; después el trastero queda libre.
    const noInventory = await http()
      .post(`/collections/${caseId}/move-goods`)
      .set(auth)
      .send({ custodyLocation: 'Nave 3' });
    expect(noInventory.status).toBe(400);
    expect(noInventory.body.code).toBe('inventory_required');
    await addFile(caseId, 'inventory');
    const moved = await http()
      .post(`/collections/${caseId}/move-goods`)
      .set(auth)
      .send({ custodyLocation: 'Nave 3' });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe('goods_moved');
    expect(moved.body.custodyLocation).toBe('Nave 3');
    expect(moved.body.abandonmentFrom).not.toBeNull();
    const freed = await admin.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(freed.status).toBe('available');
    expect(freed.outOfServiceReason).toBeNull();

    // Abandono: solo pasadas 8 semanas de custodia.
    const tooSoon = await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'abandonment' });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.code).toBe('custody_period_not_over');
    const disp = await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'court_order' });
    expect(disp.status).toBe(200);
    expect(disp.body.status).toBe('disposal');

    // Completar exige el documento del cauce legal.
    const noAct = await http()
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 0 });
    expect(noAct.status).toBe(400);
    expect(noAct.body.code).toBe('disposal_act_required');
    await addFile(caseId, 'disposal_act');
    const done = await http()
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 0 });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('closed_disposed');
    expect(done.body.closedAt).not.toBeNull();

    const detail = await http().get(`/collections/${caseId}`).set(auth);
    const types = (detail.body.events as { eventType: string }[]).map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'opened',
        'overlock_placed',
        'notice_sent',
        'notice_received',
        'deadline_expired',
        'contract_resolved',
        'goods_moved',
        'disposal_started',
        'disposal_done',
      ]),
    );
  });

  it('resumen (Resumen del panel): cuenta abiertos + deuda, ignora cerrados', async () => {
    const owner = await registerVerifiedUser(app, 'coll-summary');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { customerId, contractId, invoiceId } = await seedContractWithDebt(owner.accessToken);
    const me = await request(app.getHttpServer()).get('/auth/me').set(auth);
    const tenantId = me.body.tenant.id as string;

    const before = await request(app.getHttpServer()).get('/collections/summary').set(auth);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ openCount: 0, totalDebt: 0, byStatus: {} });

    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;

    const afterOpen = await request(app.getHttpServer()).get('/collections/summary').set(auth);
    expect(afterOpen.body.openCount).toBe(1);
    expect(afterOpen.body.totalDebt).toBe(121); // 100 + 21% IVA
    expect(afterOpen.body.byStatus).toEqual({ open: 1 });

    await request(app.getHttpServer())
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'En persona' })
      .expect(200);
    const afterOverlock = await request(app.getHttpServer()).get('/collections/summary').set(auth);
    expect(afterOverlock.body.byStatus).toEqual({ overlocked: 1 });

    // Al pagar la factura, el caso se cierra solo (closed_paid) → deja de contar.
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set(auth)
      .send({ amount: 121, methodType: 'cash' })
      .expect(200);
    await app.get(CollectionsService).onInvoicePaid(tenantId, customerId);

    const afterClose = await request(app.getHttpServer()).get('/collections/summary').set(auth);
    expect(afterClose.body).toEqual({ openCount: 0, totalDebt: 0, byStatus: {} });
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
    await request(app.getHttpServer())
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'Por teléfono' })
      .expect(200);

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
    const notice = await admin.notification.findFirst({
      where: { tenantId, type: 'collections.case_closed_paid' },
    });
    expect(notice?.body).toContain('Recuerda retirar el candado');
  });

  it('apertura manual exige deuda vencida (lo que aún no vence no cuenta)', async () => {
    const owner = await registerVerifiedUser(app, 'coll-nodebt');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { contractId, invoiceId } = await seedContractWithDebt(owner.accessToken);
    // La factura vence dentro de 10 días: aún no es deuda.
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(Date.now() + 10 * DAY), status: 'issued' },
    });
    const res = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_debt');
  });

  it('liquidación: la fianza + lo obtenido saldan la deuda por antigüedad', async () => {
    const owner = await registerVerifiedUser(app, 'coll-settle');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { contractId, invoiceId } = await seedContractWithDebt(owner.accessToken); // deuda 121€

    // Fianza de 50 € cobrada en el local.
    await admin.contract.update({
      where: { id: contractId },
      data: { depositAmount: 50, depositStatus: 'held' },
    });
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);

    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;
    await advanceToDisposal(auth, caseId);

    // Cierre con 30 € obtenidos + la fianza (50 €).
    const done = await request(app.getHttpServer())
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 3000, applyDeposit: true });
    expect(done.body.status).toBe('closed_disposed');

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
    expect(settlement!.depositReturnedCents).toBe(0);
    expect(settlement!.invoicesSettled).toBe(1);

    // La factura quedó con 80 € abonados (50 de fianza + 30 obtenidos).
    const inv = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(inv.body.amountPaid).toBe(80);
    expect(inv.body.status).not.toBe('paid');

    const contract = await admin.contract.findUnique({ where: { id: contractId } });
    expect(contract?.depositStatus).toBe('returned');
    expect(Number(contract?.depositReturnedAmount)).toBe(0);
    expect(contract?.depositSettledAt).not.toBeNull();
  });

  it('completar la disposición dos veces a la vez solo liquida una vez', async () => {
    const owner = await registerVerifiedUser(app, 'coll-race');
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { contractId, invoiceId } = await seedContractWithDebt(owner.accessToken); // deuda 121€

    await admin.contract.update({
      where: { id: contractId },
      data: { depositAmount: 50, depositStatus: 'held' },
    });
    await request(app.getHttpServer())
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);

    const open = await request(app.getHttpServer())
      .post('/collections')
      .set(auth)
      .send({ contractId });
    const caseId = open.body.id as string;
    await advanceToDisposal(auth, caseId);

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post(`/collections/${caseId}/complete-disposal`)
        .set(auth)
        .send({ proceedsCents: 3000, applyDeposit: true }),
      request(app.getHttpServer())
        .post(`/collections/${caseId}/complete-disposal`)
        .set(auth)
        .send({ proceedsCents: 3000, applyDeposit: true }),
    ]);
    // Exactamente una gana; la otra ve el expediente ya cerrado (400) o pierde
    // la reclamación atómica (409).
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);

    // La factura solo se liquidó UNA vez (50 de fianza + 30 obtenidos = 80).
    const inv = await request(app.getHttpServer()).get(`/invoices/${invoiceId}`).set(auth);
    expect(inv.body.amountPaid).toBe(80);
    const contract = await admin.contract.findUnique({ where: { id: contractId } });
    expect(contract?.depositStatus).toBe('returned');
    expect(Number(contract?.depositReturnedAmount)).toBe(0);
  });

  // La generación REAL del PDF usa Puppeteer, que no funciona bajo ts-jest
  // (CommonJS); el render (HTML) se cubre en el unit `requirement-template.spec`.
  it('el requerimiento (PDF) exige la feature collections y autenticación', async () => {
    const owner = await registerVerifiedUser(app, 'coll-req-gate');
    await setTenantPlan(owner.slug, 'free'); // free NO incluye collections
    const fakeCaseId = '00000000-0000-0000-0000-000000000000';

    await request(app.getHttpServer())
      .post(`/collections/${fakeCaseId}/requirement-pdf`)
      .set({ Authorization: `Bearer ${owner.accessToken}` })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/collections/${fakeCaseId}/requirement-pdf`)
      .expect(401);
  });
});
