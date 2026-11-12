import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { CollectionsExtrasService } from '../src/modules/collections/collections-extras.service';
import { PaymentPlansService } from '../src/modules/collections-ops/payment-plans.service';
import { DunningService } from '../src/modules/dunning/dunning.service';
import { JOB_DUNNING_PROCESS_INVOICE } from '../src/modules/queues/queues.module';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type {
  DelinquencyCaseDetailDto,
  DunningSettingsDto,
  PortalCollectionsCaseDto,
  TodayExtrasDto,
} from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const DAY = 86_400_000;
/** El día de hoy (o dentro de `n` días) en la hora de España. */
const madridDay = (n = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + n * DAY),
  );

/** Espera a que se cumpla algo que hace un escuchador de eventos. */
async function eventually(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no se cumplió a tiempo');
}

/**
 * Mejoras de Impagos: el plan de pagos pausa el expediente (y romperlo lo
 * reanuda), quitar el candado, la cita para retirar los bienes desde el área de
 * clientes con su código de un uso, los gastos del expediente, el sobrante
 * devuelto, los avisos en «Hoy» y el escalado en una sola pantalla.
 */
describe('Impagos: mejoras (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const http = () => request(app.getHttpServer());

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

  async function setup(suffix: string) {
    const owner = await registerVerifiedUser(app, suffix);
    await setTenantPlan(owner.slug, 'starter');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const me = await http().get('/auth/me').set(auth);
    const tenantId = me.body.tenant.id as string;
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local Mejoras',
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
        documentType: 'dni',
        documentNumber: '12345678Z',
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
    const open = await http().post('/collections').set(auth).send({ contractId }).expect(201);
    return {
      auth,
      tenantId,
      facilityId,
      unitId,
      customerId,
      contractId,
      invoiceId,
      caseId: open.body.id as string,
    };
  }

  /** Lleva el expediente hasta el contrato resuelto. */
  async function resolve(auth: Record<string, string>, caseId: string) {
    await http()
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'Carta' })
      .expect(200);
    await http().post(`/collections/${caseId}/notice`).set(auth).send({}).expect(200);
    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { finalNoticeDeadline: new Date(Date.now() - DAY) },
    });
    await http().post(`/collections/${caseId}/resolution-pending`).set(auth).expect(200);
    await http().post(`/collections/${caseId}/resolve-contract`).set(auth).send({}).expect(200);
  }

  async function portalSession(auth: Record<string, string>, customerId: string) {
    const link = await http().post(`/customers/${customerId}/portal-link`).set(auth).expect(201);
    const token = new URL(link.body.url as string).searchParams.get('token');
    const consume = await http().post('/portal/login/consume').send({ token }).expect(200);
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  it('un plan de pagos pausa el expediente; quitar el candado; si se rompe, sigue y avisa', async () => {
    const { auth, tenantId, customerId, caseId } = await setup('collfeat-plan');
    await http()
      .post(`/collections/${caseId}/overlock`)
      .set(auth)
      .send({ priorNotice: 'Carta' })
      .expect(200);

    const plan = await http()
      .post('/payment-plans')
      .set(auth)
      .send({
        customerId,
        installmentsCount: 2,
        firstDueDate: madridDay(),
        graceDays: 0,
        notifyCustomer: false,
      })
      .expect(201);
    await eventually(async () => {
      const row = await admin.delinquencyCase.findUniqueOrThrow({ where: { id: caseId } });
      return !!row.pausedAt;
    });

    // En pausa no avanza (sí se podría cerrar).
    const blocked = await http().post(`/collections/${caseId}/notice`).set(auth).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('case_paused');
    const paused = (await http().get(`/collections/${caseId}`).set(auth).expect(200))
      .body as DelinquencyCaseDetailDto;
    expect(paused.paymentPlanId).toBe(plan.body.id);
    expect(paused.noticeChecklist.find((i) => i.key === 'address')?.ok).toBe(true);
    expect(paused.noticeChecklist.find((i) => i.key === 'reminded')?.ok).toBe(false);

    // «Hoy»: con plan de pagos, toca quitar el candado.
    const extras = (await http().get('/dashboard/today/extras').set(auth).expect(200))
      .body as TodayExtrasDto;
    const item = extras.collectionsAlerts.items.find((i) => i.refId === caseId);
    expect(item?.detail).toContain('Tiene un plan de pagos: quita el candado');
    expect(item?.href).toBe(`/collections/${caseId}`);

    await http()
      .post(`/collections/${caseId}/remove-overlock`)
      .set(auth)
      .send({ notes: 'Plan de pagos firmado' })
      .expect(204);
    const again = await http().post(`/collections/${caseId}/remove-overlock`).set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('overlock_already_removed');

    // Pasa el plazo de la primera cuota sin pagar: el plan se rompe y el
    // expediente sigue donde se quedó.
    await app.get(PaymentPlansService).evaluateAll(new Date(Date.now() + 40 * DAY));
    await eventually(async () => {
      const row = await admin.delinquencyCase.findUniqueOrThrow({ where: { id: caseId } });
      return row.pausedAt === null;
    });
    const broken = await admin.notification.findFirst({
      where: { tenantId, type: 'collections.plan_broken' },
    });
    expect(broken?.link).toBe(`/collections/${caseId}`);
    await http().post(`/collections/${caseId}/notice`).set(auth).send({}).expect(200);
  });

  it('cita para retirar los bienes: la pide el inquilino y el equipo la concede con un código de un uso', async () => {
    const { auth, tenantId, facilityId, unitId, customerId, caseId } =
      await setup('collfeat-pickup');
    const portal = await portalSession(auth, customerId);

    // Antes de resolver el contrato aún no hace falta pedir cita.
    let cases = (await http().get('/portal/me/collections').set(portal).expect(200))
      .body as PortalCollectionsCaseDto[];
    expect(cases).toHaveLength(1);
    expect(cases[0]!.canRequestPickup).toBe(false);
    expect(cases[0]!.debtCents).toBe(12100);
    const early = await http()
      .post(`/portal/me/collections/${caseId}/pickup`)
      .set(portal)
      .send({ preferredDate: madridDay(1), preferredTime: 'morning' });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('pickup_not_available');

    await resolve(auth, caseId);
    const past = await http()
      .post(`/portal/me/collections/${caseId}/pickup`)
      .set(portal)
      .send({ preferredDate: madridDay(-3), preferredTime: 'morning' });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('invalid_preferred_date');
    cases = (
      await http()
        .post(`/portal/me/collections/${caseId}/pickup`)
        .set(portal)
        .send({ preferredDate: madridDay(1), preferredTime: 'morning', note: 'Con furgoneta' })
        .expect(200)
    ).body as PortalCollectionsCaseDto[];
    expect(cases[0]!.canRequestPickup).toBe(false);
    expect(cases[0]!.pickups[0]).toEqual(
      expect.objectContaining({ status: 'pending', preferredTime: 'morning', code: null }),
    );
    const twice = await http()
      .post(`/portal/me/collections/${caseId}/pickup`)
      .set(portal)
      .send({ preferredDate: madridDay(2), preferredTime: 'any' });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('pickup_already_requested');
    expect(
      await admin.notification.findFirst({
        where: { tenantId, type: 'collections.pickup_requested' },
      }),
    ).not.toBeNull();

    const detail = (await http().get(`/collections/${caseId}`).set(auth).expect(200))
      .body as DelinquencyCaseDetailDto;
    const pickupId = detail.pickups[0]!.id;
    const bad = await http()
      .post(`/collections/${caseId}/pickups/${pickupId}/approve`)
      .set(auth)
      .send({ date: madridDay(1), from: '12:00', to: '10:00' });
    expect(bad.status).toBe(400);
    await http()
      .post(`/collections/${caseId}/pickups/${pickupId}/approve`)
      .set(auth)
      .send({ date: madridDay(1), from: '10:00', to: '12:00' })
      .expect(204);
    const twiceApproved = await http()
      .post(`/collections/${caseId}/pickups/${pickupId}/approve`)
      .set(auth)
      .send({ date: madridDay(1), from: '10:00', to: '12:00' });
    expect(twiceApproved.status).toBe(409);

    // El código solo lo ve el inquilino: abre el local y su trastero, una vez.
    const staffView = (await http().get(`/collections/${caseId}`).set(auth).expect(200))
      .body as DelinquencyCaseDetailDto;
    expect(staffView.pickups[0]).toEqual(
      expect.objectContaining({ status: 'approved', code: null }),
    );
    cases = (await http().get('/portal/me/collections').set(portal).expect(200))
      .body as PortalCollectionsCaseDto[];
    const code = cases[0]!.pickups[0]!.code;
    expect(code).toMatch(/^\d{6,8}$/);
    const pickupRow = await admin.delinquencyPickupRequest.findUniqueOrThrow({
      where: { id: pickupId },
    });
    const credential = await admin.accessCredential.findUniqueOrThrow({
      where: { id: pickupRow.credentialId! },
    });
    expect(credential.maxUses).toBe(1);
    expect(credential.bypassCurfew).toBe(true);
    expect(credential.allowedFacilityIds).toEqual([facilityId]);
    expect(credential.allowedUnitIds).toEqual([unitId]);
    expect((credential.metadata as { source?: string }).source).toBe('collections_pickup');
    expect(credential.expiresAt!.getTime()).toBeGreaterThan(credential.validFrom!.getTime());
    // El correo de la cita no lleva el código.
    const mail = await admin.communication.findFirst({
      where: { tenantId, source: 'collections.pickup' },
      orderBy: { createdAt: 'desc' },
    });
    expect(mail?.subject).toBe('Tu cita para retirar tus bienes');
    expect(mail?.bodyText).not.toContain(code!);

    await http().post(`/collections/${caseId}/pickups/${pickupId}/done`).set(auth).expect(204);
    const revoked = await admin.accessCredential.findUniqueOrThrow({
      where: { id: credential.id },
    });
    expect(revoked.status).toBe('revoked');
    cases = (await http().get('/portal/me/collections').set(portal).expect(200))
      .body as PortalCollectionsCaseDto[];
    expect(cases[0]!.pickups[0]!.code).toBeNull();
    expect(cases[0]!.canRequestPickup).toBe(true);
  });

  it('gastos del expediente, sobrante devuelto, documentos y avisos al equipo', async () => {
    const { auth, tenantId, caseId } = await setup('collfeat-charges');

    const noOverlock = await http()
      .post(`/collections/${caseId}/remove-overlock`)
      .set(auth)
      .send({});
    expect(noOverlock.status).toBe(400);
    expect(noOverlock.body.code).toBe('no_overlock');
    const noSurplus = await http()
      .post(`/collections/${caseId}/surplus-returned`)
      .set(auth)
      .send({});
    expect(noSurplus.status).toBe(400);
    expect(noSurplus.body.code).toBe('no_surplus');

    // El acta del traslado es para después de resolver el contrato.
    const act = await http()
      .post(`/collections/${caseId}/custody-act-pdf`)
      .set(auth)
      .send({ items: 'Sofá\nCajas' });
    expect(act.status).toBe(400);
    expect(act.body.code).toBe('contract_not_resolved');

    const charge = await http()
      .post(`/collections/${caseId}/charges`)
      .set(auth)
      .send({ kind: 'transfer', amount: 50 })
      .expect(200);
    expect(charge.body.invoiceNumber).toBeTruthy();
    const detail = (await http().get(`/collections/${caseId}`).set(auth).expect(200))
      .body as DelinquencyCaseDetailDto;
    expect(detail.charges).toEqual([
      expect.objectContaining({ invoiceId: charge.body.invoiceId, kind: 'transfer', total: 60.5 }),
    ]);
    const line = await admin.invoiceItem.findFirst({ where: { invoiceId: charge.body.invoiceId } });
    expect(line?.description).toMatch(/^Traslado de los bienes — trastero U-1-/);

    // El sobrante, una vez.
    await admin.delinquencyCase.update({ where: { id: caseId }, data: { surplusCents: 2900 } });
    await http()
      .post(`/collections/${caseId}/surplus-returned`)
      .set(auth)
      .send({ notes: 'Transferencia' })
      .expect(204);
    const twice = await http().post(`/collections/${caseId}/surplus-returned`).set(auth).send({});
    expect(twice.status).toBe(409);

    // Expediente parado 15 días: un aviso al móvil y no se repite al día siguiente.
    await admin.delinquencyCaseEvent.updateMany({
      where: { caseId },
      data: { occurredAt: new Date(Date.now() - 15 * DAY) },
    });
    await admin.delinquencyCase.update({
      where: { id: caseId },
      data: { updatedAt: new Date(Date.now() - 15 * DAY) },
    });
    const extras = app.get(CollectionsExtrasService);
    await extras.sendAlerts();
    const first = await admin.notification.count({
      where: { tenantId, type: 'collections.stalled' },
    });
    expect(first).toBe(1);
    await extras.sendAlerts(new Date(Date.now() + DAY));
    expect(
      await admin.notification.count({ where: { tenantId, type: 'collections.stalled' } }),
    ).toBe(1);
  });

  it('el escalado en una pantalla: días de cada paso y el calendario los usa', async () => {
    const { auth, tenantId, customerId, contractId } = await setup('collfeat-dunning');
    const initial = (await http().get('/dunning/settings').set(auth).expect(200))
      .body as DunningSettingsDto;
    expect(initial).toEqual(
      expect.objectContaining({
        firstReminderDays: 1,
        secondReminderDays: 7,
        accessCutMode: 'all',
        legalNoticeDays: 30,
      }),
    );
    expect(initial.templates.firstReminder).toBeTruthy();

    const settings = {
      firstReminderDays: 3,
      secondReminderDays: 10,
      lateFeeEnabled: true,
      lateFeeType: 'percentage',
      lateFeeValue: 5,
      lateFeeGraceDays: 12,
      accessCutMode: 'extras',
      accessCutDays: 20,
      legalNoticeDays: 45,
    };
    await http()
      .put('/dunning/settings')
      .set(auth)
      .send({ ...settings, secondReminderDays: 2 })
      .expect(400);
    await http()
      .put('/dunning/settings')
      .set(auth)
      .send({ ...settings, lateFeeValue: 150 })
      .expect(400);
    const saved = (await http().put('/dunning/settings').set(auth).send(settings).expect(200))
      .body as DunningSettingsDto;
    expect(saved).toEqual(expect.objectContaining(settings));
    const billing = await http().get('/settings/tenant/billing').set(auth).expect(200);
    expect(billing.body.lateFeeGraceDays).toBe(12);

    // Una factura que vence ahora sigue los días nuevos.
    const inv = await http()
      .post('/invoices')
      .set(auth)
      .send({
        customerId,
        contractId,
        items: [{ description: 'Cuota', quantity: 1, unitPrice: 50, taxRate: 21 }],
      });
    const invoiceId = inv.body.id as string;
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const due = new Date(Date.now() - 2 * DAY);
    await admin.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: due, status: 'overdue' },
    });
    await app
      .get(DunningService)
      .handleJob(JOB_DUNNING_PROCESS_INVOICE, { tenantId, invoiceId, daysOverdue: 2 });
    const actions = await admin.dunningAction.findMany({
      where: { invoiceId, supersededAt: null },
      orderBy: { scheduledFor: 'asc' },
    });
    // El vencimiento es un día (sin hora): se cuenta desde el guardado.
    const stored = await admin.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const days = Object.fromEntries(
      actions.map((a) => [
        a.actionType,
        Math.round((a.scheduledFor.getTime() - stored.dueDate!.getTime()) / DAY),
      ]),
    );
    expect(days).toEqual(
      expect.objectContaining({
        email_reminder: 3,
        email_reminder_final: 10,
        late_fee: 12,
        access_block: 20,
        legal_notice: 45,
      }),
    );
  });
});
