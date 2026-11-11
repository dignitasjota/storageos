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
 * Revisión de Impagos: aviso previo al candado, trastero bloqueado mientras los
 * bienes siguen dentro, cierre al anular la deuda, el aviso legal del escalado,
 * el requerimiento y los filtros y ajustes validados.
 */
describe('Impagos: revisión (e2e)', () => {
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

  async function setup(suffix: string, customer: Record<string, unknown> = {}) {
    const owner = await registerVerifiedUser(app, suffix);
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const http = () => request(app.getHttpServer());
    const me = await http().get('/auth/me').set(auth);
    const tenantId = me.body.tenant.id as string;
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Revisión',
      unitsCount: 1,
      pricePerUnit: 100,
    });
    const unitId = unitIds[0]!;
    const c = await http()
      .post('/customers')
      .set(auth)
      .send({
        customerType: 'individual',
        firstName: 'Ana',
        lastName: 'Debe',
        email: `ana.${suffix}@example.com`,
        country: 'ES',
        address: 'Calle Mayor 1',
        city: 'Madrid',
        postalCode: '28001',
        ...customer,
      });
    expect(c.status).toBe(201);
    const customerId = c.body.id as string;
    const contract = await http().post('/contracts').set(auth).send({
      customerId,
      unitId,
      startDate: '2026-01-01',
      priceMonthly: 100,
      billingCycle: 'monthly',
      cancellationNoticeDays: 30,
    });
    expect(contract.status).toBe(201);
    const contractId = contract.body.id as string;
    await http().post(`/contracts/${contractId}/sign`).set(auth).send({}).expect(200);
    await ensureDefaultSeries(app, owner.accessToken);
    const inv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 100, taxRate: 21 }],
      });
    const invoiceId = inv.body.id as string;
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(Date.now() - 40 * DAY), status: 'overdue' },
    });
    return { auth, http, tenantId, customerId, contractId, invoiceId, unitId };
  }

  it('el candado vale tras un recordatorio de pago, sin más constancia', async () => {
    const { auth, http, contractId, invoiceId } = await setup('coll-rev-remind');
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    const caseId = open.body.id as string;

    const before = await http().get(`/collections/${caseId}`).set(auth);
    expect(before.body.reminded).toBe(false);
    expect(before.body.invoices).toHaveLength(1);
    expect(before.body.invoices[0].pendingCents).toBe(12100);

    await http()
      .post('/invoices/bulk/remind')
      .set(auth)
      .send({ ids: [invoiceId] })
      .expect(200);
    const after = await http().get(`/collections/${caseId}`).set(auth);
    expect(after.body.reminded).toBe(true);
    await http().post(`/collections/${caseId}/overlock`).set(auth).send({}).expect(200);

    // Dos acciones a la vez sobre el mismo expediente: solo una avanza.
    const [a, b] = await Promise.all([
      http().post(`/collections/${caseId}/notice`).set(auth).send({}),
      http().post(`/collections/${caseId}/notice`).set(auth).send({}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([400, 409]).toContain(statuses[1]);
  });

  it('con un impago abierto el trastero no vuelve a la venta al terminar el contrato', async () => {
    const { auth, http, contractId, unitId } = await setup('coll-rev-end');
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    const caseId = open.body.id as string;

    await http().post(`/contracts/${contractId}/end`).set(auth).send({}).expect(200);
    const unit = await admin.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(unit.status).toBe('blocked');
    expect(unit.outOfServiceReason).toContain('Impago');

    // El paso «contrato resuelto» no vuelve a terminarlo (ya terminó).
    await http().post(`/collections/${caseId}/overlock`).set(auth).send({ priorNotice: 'Carta' });
    await http().post(`/collections/${caseId}/notice`).set(auth).send({});
    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { finalNoticeDeadline: new Date(Date.now() - DAY) },
    });
    await http().post(`/collections/${caseId}/resolution-pending`).set(auth).expect(200);
    await http().post(`/collections/${caseId}/resolve-contract`).set(auth).send({}).expect(200);

    // Cancelar el expediente avisa de que los bienes siguen dentro.
    await http()
      .post(`/collections/${caseId}/cancel`)
      .set(auth)
      .send({ reason: 'Acuerdo con el inquilino' })
      .expect(200);
    const still = await admin.unit.findUniqueOrThrow({ where: { id: unitId } });
    expect(still.status).toBe('blocked');
  });

  it('anular la factura deja el expediente sin deuda y lo cierra', async () => {
    const { auth, http, tenantId, contractId, invoiceId } = await setup('coll-rev-void');
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    const caseId = open.body.id as string;

    await http()
      .post(`/invoices/${invoiceId}/cancel`)
      .set(auth)
      .send({ reason: 'Emitida por error' })
      .expect(200);
    await app.get(CollectionsService).onInvoiceVoided(tenantId, invoiceId);

    const detail = await http().get(`/collections/${caseId}`).set(auth);
    expect(detail.body.status).toBe('closed_cancelled');
    const closed = (detail.body.events as { eventType: string; payload: { reason?: string } }[])
      .filter((e) => e.eventType === 'closed')
      .map((e) => e.payload.reason);
    expect(closed).toContain('debt_voided');
  });

  it('aviso legal del escalado: abre expediente solo si se usan y el contrato sigue', async () => {
    const { auth, http, tenantId, contractId, invoiceId } = await setup('coll-rev-dunning');
    const service = app.get(CollectionsService);

    // Sin expedientes activados: avisa al equipo.
    expect(await service.openFromDunning(tenantId, invoiceId)).toBe('notified');
    const notice = await admin.notification.findFirst({
      where: { tenantId, type: 'collections.long_overdue' },
    });
    expect(notice?.body).toContain('121,00');
    expect(notice?.link).toBe('/arrears');

    await http()
      .put('/collections/settings')
      .set(auth)
      .send({ collectionsEnabled: true })
      .expect(200);
    expect(await service.openFromDunning(tenantId, invoiceId)).toBe('opened');
    expect(await service.openFromDunning(tenantId, invoiceId)).toBe('exists');

    // Contrato ya terminado: no se abre otro (avisa).
    const list = await http().get('/collections').set(auth);
    await http()
      .post(`/collections/${list.body[0].id}/cancel`)
      .set(auth)
      .send({ reason: 'Prueba' })
      .expect(200);
    await http().post(`/contracts/${contractId}/end`).set(auth).send({}).expect(200);
    expect(await service.openFromDunning(tenantId, invoiceId)).toBe('notified');
  });

  it('el requerimiento exige la dirección del inquilino y un expediente abierto', async () => {
    const { auth, http, contractId } = await setup('coll-rev-pdf', {
      address: undefined,
      city: undefined,
    });
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    const caseId = open.body.id as string;

    const noAddress = await http().post(`/collections/${caseId}/requirement-pdf`).set(auth);
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.code).toBe('customer_address_required');

    await http()
      .post(`/collections/${caseId}/cancel`)
      .set(auth)
      .send({ reason: 'Pagó en mano' })
      .expect(200);
    const closed = await http().post(`/collections/${caseId}/requirement-pdf`).set(auth);
    expect(closed.status).toBe(400);
    expect(closed.body.code).toBe('case_closed');
  });

  it('lo que sobra tras saldar la deuda se avisa para devolverlo', async () => {
    const { auth, http, tenantId, contractId } = await setup('coll-rev-surplus');
    await admin.contract.update({
      where: { id: contractId },
      data: { depositAmount: 50, depositStatus: 'held' },
    });
    await http()
      .post(`/contracts/${contractId}/deposit/collect`)
      .set(auth)
      .send({ methodType: 'cash' })
      .expect(200);
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    const caseId = open.body.id as string;
    await http().post(`/collections/${caseId}/overlock`).set(auth).send({ priorNotice: 'Carta' });
    await http().post(`/collections/${caseId}/notice`).set(auth).send({});
    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { finalNoticeDeadline: new Date(Date.now() - DAY) },
    });
    await http().post(`/collections/${caseId}/resolution-pending`).set(auth).expect(200);
    await http().post(`/collections/${caseId}/resolve-contract`).set(auth).send({}).expect(200);
    for (const kind of ['inventory', 'disposal_act']) {
      await admin.delinquencyCaseFile.create({
        data: {
          tenantId,
          caseId,
          kind,
          objectKey: `${tenantId}/collections/${caseId}/${kind}/x.pdf`,
          contentType: 'application/pdf',
        },
      });
    }
    await http()
      .post(`/collections/${caseId}/move-goods`)
      .set(auth)
      .send({ custodyLocation: 'Nave 1' })
      .expect(200);
    await http()
      .post(`/collections/${caseId}/disposal`)
      .set(auth)
      .send({ disposalType: 'written_agreement' })
      .expect(200);
    // 100 € obtenidos + 50 de fianza sobre 121 de deuda: se aplica primero la
    // fianza (50) y 71 de lo obtenido; sobran 29 € para devolver.
    const done = await http()
      .post(`/collections/${caseId}/complete-disposal`)
      .set(auth)
      .send({ proceedsCents: 10000, applyDeposit: true });
    expect(done.status).toBe(200);
    const notice = await admin.notification.findFirst({
      where: { tenantId, type: 'collections.surplus_to_return' },
    });
    expect(notice?.title).toContain('29,00');
  });

  it('filtros y ajustes validados', async () => {
    const { auth, http } = await setup('coll-rev-params');
    const badStatus = await http().get('/collections').set(auth).query({ status: 'nope' });
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('invalid_status');
    const badFacility = await http().get('/collections').set(auth).query({ facilityId: 'x' });
    expect(badFacility.status).toBe(400);
    expect(badFacility.body.code).toBe('invalid_facility_id');
    const badSummary = await http()
      .get('/collections/summary')
      .set(auth)
      .query({ facilityId: 'x' });
    expect(badSummary.status).toBe(400);

    // Plazo del requerimiento: nunca menos de 15 días (condición 12).
    await http()
      .put('/collections/settings')
      .set(auth)
      .send({ collectionsNoticeDays: 10 })
      .expect(400);
    await http()
      .put('/collections/settings')
      .set(auth)
      .send({ collectionsOpenAfterDays: 3 })
      .expect(400);
    const ok = await http()
      .put('/collections/settings')
      .set(auth)
      .send({ collectionsNoticeDays: 20, collectionsOpenAfterDays: 45 });
    expect(ok.status).toBe(200);
    expect(ok.body.collectionsNoticeDays).toBe(20);
  });
});
