import { permissionsForRole } from '@storageos/shared';
import ExcelJS from 'exceljs';
import request from 'supertest';

import { AI_PROVIDER, type AiProvider } from '../src/modules/ai/ai-provider';
import { AiScheduledService } from '../src/modules/ai/ai-scheduled.service';
import { AiToolsService } from '../src/modules/ai/ai-tools.service';
import { FilesService } from '../src/modules/files/files.service';
import { EXTRA_REPORT_GENERATORS } from '../src/modules/reports/generators/extra-reports.generators';
import { ReportSchedulesService } from '../src/modules/reports/report-schedules.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { signedContractFor } from './helpers/contract-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants, setTenantPlan, withAdminDb } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { ReportGenerator } from '../src/modules/reports/generators/types';
import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;
// «Hoy» en hora de España: las facturas se fechan así, y entre las 00:00 y las 01:00/02:00
// de España la fecha UTC aún es la del día anterior.
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

/** Mejoras de Informes y del Asistente IA. */
describe('Mejoras de Informes y Asistente IA (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
  });

  /** Un negocio con un inquilino que debe una factura vencida y un trastero libre. */
  async function business(tag: string) {
    const owner = await registerVerifiedUser(app, tag);
    await setTenantPlan(owner.slug, 'pro');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const facility = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Centro',
      unitsCount: 2,
    });
    const customerId = await createCustomer(app, owner.accessToken, {
      firstName: 'Rosa',
      lastName: 'Deudora',
      email: `rosa-${tag}@e2e.local`,
    });
    const contract = await signedContractFor(
      app,
      owner.accessToken,
      { id: customerId },
      facility.facilityId,
    );
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).expect(200);
    const invoice = await withAdminDb(async (db) => {
      await db.invoice.update({
        where: { id: invoiceId },
        data: { dueDate: new Date(Date.now() - 20 * DAY), status: 'overdue' },
      });
      await db.contract.update({
        where: { id: contract.contractId },
        data: {
          endDate: new Date(Date.now() + 10 * DAY),
          autoRenew: false,
          depositAmount: 60,
          depositStatus: 'held',
        },
      });
      return db.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    });
    return { owner, auth, facility, customerId, contract, invoice };
  }

  it('informes nuevos: salen en el catálogo y con datos', async () => {
    const b = await business('repnew');
    const catalog = await http().get('/reports/catalog').set(b.auth).expect(200);
    const codes = (catalog.body as { code: string }[]).map((c) => c.code);
    for (const code of [
      'debtors_by_customer',
      'contracts_ending',
      'free_units',
      'deposits_held',
      'invoicing_by_unit_type',
      'leads_by_source',
    ]) {
      expect(codes).toContain(code);
    }

    const run = (cls: (typeof EXTRA_REPORT_GENERATORS)[number], params = {}) =>
      (app.get(cls) as ReportGenerator).run({
        tenantId: b.owner.tenantId,
        params,
        scope: { ids: undefined, explicit: false },
        timezone: 'Europe/Madrid',
      });
    const [debtors, ending, free, deposits, byType] = await Promise.all([
      run(EXTRA_REPORT_GENERATORS[0]!),
      run(EXTRA_REPORT_GENERATORS[1]!, { days: '30' }),
      run(EXTRA_REPORT_GENERATORS[2]!),
      run(EXTRA_REPORT_GENERATORS[3]!),
      run(EXTRA_REPORT_GENERATORS[4]!, {
        from: new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10),
        to: today(),
      }),
    ]);
    expect(debtors.rows[0]).toMatchObject({ customer: 'Rosa Deudora', invoices: 1 });
    expect(Number(debtors.rows[0]!.days)).toBeGreaterThanOrEqual(19);
    expect(ending.rows[0]).toMatchObject({ customer: 'Rosa Deudora', renews: 'No' });
    expect(free.rows.length).toBeGreaterThanOrEqual(2);
    expect(deposits.rows[0]).toMatchObject({ deposit: 60, collected: 'Pendiente de cobro' });
    expect(byType.rows.length).toBeGreaterThan(0);
  });

  it('vista previa: primeras filas y totales sin guardar el informe', async () => {
    const b = await business('repprev');
    const res = await http()
      .post('/reports/preview')
      .set(b.auth)
      .send({ generator: 'debtors_by_customer', params: {} })
      .expect(200);
    expect(res.body).toMatchObject({ title: 'Deudores por inquilino', totalRows: 1 });
    expect(res.body.rows[0].customer).toBe('Rosa Deudora');
    expect((await http().get('/reports').set(b.auth)).body).toEqual([]);
    await http()
      .post('/reports/preview')
      .set(b.auth)
      .send({ generator: 'invoices_period', params: {} })
      .expect(400);
  });

  it('el Excel lleva el nombre y el color del negocio', async () => {
    const b = await business('repbrand');
    await withAdminDb((db) =>
      db.tenant.update({ where: { id: b.owner.tenantId }, data: { portalBrandColor: '#aa3300' } }),
    );
    const run = await http()
      .post('/reports/run')
      .set(b.auth)
      .send({ generator: 'contracts_active', format: 'xlsx', params: {} })
      .expect(201);
    let row: { status: string; downloadUrl: string | null } | null = null;
    for (let i = 0; i < 40 && row?.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      row = await withAdminDb((db) => db.reportRun.findUnique({ where: { id: run.body.id } }));
    }
    expect(row?.status).toBe('done');
    const files = app.get(FilesService);
    const key = files.keyFromPublicUrl('reports', row!.downloadUrl!)!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await files.getObject({ bucket: 'reports', key })) as never);
    const sheet = wb.worksheets[0]!;
    const tenant = await withAdminDb((db) =>
      db.tenant.findUniqueOrThrow({ where: { id: b.owner.tenantId } }),
    );
    expect(sheet.getRow(1).getCell(1).value).toBe(tenant.name);
    expect(sheet.getRow(2).getCell(1).font?.color?.argb).toBe('FFAA3300');
  });

  it('informes programados: llegan por correo con un enlace que descarga', async () => {
    const b = await business('repsched');
    const recipient = `asesoria-${Date.now()}@e2e.local`;
    const created = await http()
      .post('/reports/schedules')
      .set(b.auth)
      .send({
        generator: 'invoices_period',
        format: 'xlsx',
        params: {},
        frequency: 'monthly',
        dayOfMonth: 1,
        hour: 8,
        recipients: [recipient],
      })
      .expect(201);
    expect(new Date(created.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    // Falta un dato que no es una fecha (propietario): 400.
    await http()
      .post('/reports/schedules')
      .set(b.auth)
      .send({ generator: 'debtors_by_customer', frequency: 'weekly', recipients: ['x@y.com'] })
      .expect(400);

    await withAdminDb((db) =>
      db.reportSchedule.update({
        where: { id: created.body.id },
        data: { nextRunAt: new Date(Date.now() - 60_000) },
      }),
    );
    expect(await app.get(ReportSchedulesService).runDue()).toBe(1);
    const mail = await waitForEmail(recipient, { subjectIncludes: 'Facturas emitidas' });
    const link = /\/v1\/public\/report-files\/([\w.-]+)/.exec(mail.Text ?? '')![1]!;
    const res = await http().get(`/public/report-files/${link}`).expect(302);
    expect(res.headers.location).toContain('X-Amz-Signature');
    await http().get(`/public/report-files/${link}x`).expect(404);

    const list = await http().get('/reports/schedules').set(b.auth).expect(200);
    expect(list.body[0]).toMatchObject({ lastError: null, isActive: true });
    expect(new Date(list.body[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
    // Una segunda pasada no lo repite.
    expect(await app.get(ReportSchedulesService).runDue()).toBe(0);
    await http().delete(`/reports/schedules/${created.body.id}`).set(b.auth).expect(204);
  });

  it('asistente: nota, seguimiento y recordatorio a varias facturas; las propuestas caducan', async () => {
    const b = await business('aiacts');
    const tools = app.get(AiToolsService);
    const conv = await http().post('/ai/chat').set(b.auth).send({ content: 'Hola' });
    const ctx = {
      tenantId: b.owner.tenantId,
      permissions: permissionsForRole('owner'),
      facilityScope: null,
      userId: b.owner.userId,
      conversationId: conv.body.conversationId as string,
      proposedActionIds: [] as string[],
    };
    await tools.execute(ctx, 'propose_customer_note', {
      customerId: b.customerId,
      content: 'Llamó: paga el viernes',
      type: 'call',
    });
    await tools.execute(ctx, 'propose_customer_followup', {
      customerId: b.customerId,
      title: 'Comprobar el pago',
      dueDate: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10),
    });
    const second = await createDraftInvoice(app, b.owner.accessToken, b.customerId);
    await http().post(`/invoices/${second}/issue`).set(b.auth).expect(200);
    const secondRow = await withAdminDb((db) =>
      db.invoice.findUniqueOrThrow({ where: { id: second } }),
    );
    const reminder = JSON.parse(
      await tools.execute(ctx, 'propose_payment_reminder', {
        invoiceNumbers: [b.invoice.invoiceNumber, secondRow.invoiceNumber],
      }),
    ) as { summary: string };
    expect(reminder.summary).toContain('2 facturas');
    const [noteId, followupId, reminderId] = ctx.proposedActionIds;

    await http().post(`/ai/actions/${noteId}/confirm`).set(b.auth).expect(200);
    await http().post(`/ai/actions/${followupId}/confirm`).set(b.auth).expect(200);
    const sent = await http().post(`/ai/actions/${reminderId}/confirm`).set(b.auth).expect(200);
    expect(sent.body.status).toBe('confirmed');
    const [notes, followups] = await withAdminDb((db) =>
      Promise.all([
        db.customerInteraction.findMany({ where: { customerId: b.customerId } }),
        db.customerFollowup.findMany({ where: { customerId: b.customerId } }),
      ]),
    );
    expect(notes.map((n) => [n.type, n.content])).toContainEqual([
      'call',
      'Llamó: paga el viernes',
    ]);
    expect(followups.map((f) => f.title)).toContain('Comprobar el pago');

    // Una propuesta de hace 8 días ya no se puede confirmar.
    await tools.execute(ctx, 'propose_create_task', { title: 'Vieja' });
    const oldId = ctx.proposedActionIds.at(-1)!;
    await withAdminDb((db) =>
      db.aiPendingAction.update({
        where: { id: oldId },
        data: { createdAt: new Date(Date.now() - 8 * DAY) },
      }),
    );
    const expired = await http().post(`/ai/actions/${oldId}/confirm`).set(b.auth).expect(400);
    expect(expired.body.code).toBe('ai_action_expired');
  });

  it('asistente: preguntar desde una ficha y sugerencias del día', async () => {
    const b = await business('aiabout');
    const provider = app.get<AiProvider>(AI_PROVIDER);
    const spy = jest.spyOn(provider, 'createMessage');
    await http()
      .post('/ai/chat')
      .set(b.auth)
      .send({ content: '¿Cuánto debe?', about: { type: 'customer', id: b.customerId } })
      .expect(200);
    const system = spy.mock.calls[0]![0].system as { dynamic?: string };
    expect(system.dynamic).toContain(b.customerId);

    const suggestions = await http().get('/ai/suggestions').set(b.auth).expect(200);
    expect(suggestions.body[0]).toContain('1 factura vencida');
    expect(suggestions.body.join(' ')).toContain('vence');
  });

  it('asistente: las preguntas programadas responden y llegan por correo', async () => {
    const b = await business('aisched');
    const created = await http()
      .post('/ai/scheduled-questions')
      .set(b.auth)
      .send({ question: '¿Quién me debe dinero?', frequency: 'weekly', weekday: 1, hour: 8 })
      .expect(201);
    await withAdminDb((db) =>
      db.aiScheduledQuestion.update({
        where: { id: created.body.id },
        data: { nextRunAt: new Date(Date.now() - 60_000) },
      }),
    );
    expect(await app.get(AiScheduledService).runDue()).toBe(1);
    await waitForEmail(b.owner.email, { subjectIncludes: 'Tu pregunta al asistente' });
    const list = await http().get('/ai/scheduled-questions').set(b.auth).expect(200);
    expect(list.body[0].lastConversationId).toBeTruthy();
    expect(list.body[0].lastError).toBeNull();
    expect(new Date(list.body[0].nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
});
