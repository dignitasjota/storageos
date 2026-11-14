import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Operaciones diarias, PR B: mejoras. */
describe('Operaciones diarias: mejoras (e2e)', () => {
  let app: INestApplication;
  let db: PrismaAdminService;
  const http = () => request(app.getHttpServer());
  const today = () => todayInTimezone('Europe/Madrid');

  beforeAll(async () => {
    await cleanupTestTenants();
    app = await createTestApp();
    db = app.get(PrismaAdminService);
  });

  afterAll(async () => {
    await app.close();
    await cleanupTestTenants();
    await deleteAllMessages();
  });

  async function setup(tag: string, units = 2) {
    const owner = await registerVerifiedUser(app, tag);
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const fac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: units });
    const me = await http().get('/auth/me').set(auth);
    return {
      owner,
      auth,
      fac,
      tenantId: me.body.tenant.id as string,
      userId: me.body.user.id as string,
    };
  }

  /** Sube un PNG por la URL firmada y devuelve lo que hay que registrar. */
  async function upload(path: string, auth: Record<string, string>) {
    const presign = await http().post(path).set(auth).send({ mimeType: 'image/png' }).expect(200);
    await fetch(presign.body.uploadUrl as string, {
      method: 'PUT',
      headers: presign.body.requiredHeaders as Record<string, string>,
      body: PNG,
    });
    return { key: presign.body.key as string, mimeType: 'image/png', filename: 'foto.png' };
  }

  async function portalLogin(slug: string, email: string): Promise<{ Authorization: string }> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  it('tareas: pendientes, mis tareas, fotos y gasto con el proveedor del plan', async () => {
    const { auth, userId } = await setup('opsb-tasks');
    const t = today();
    await http()
      .post('/tasks')
      .set(auth)
      .send({
        title: 'Atrasada',
        dueDate: ymd(new Date(t.getTime() - 2 * DAY)),
        assignedToUserId: userId,
      })
      .expect(201);
    await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'De hoy', dueDate: ymd(t), assignedToUserId: userId })
      .expect(201);
    await http().post('/tasks').set(auth).send({ title: 'Sin fecha' }).expect(201);

    const overdue = await http().get('/tasks?due=overdue').set(auth).expect(200);
    expect((overdue.body as { title: string }[]).map((x) => x.title)).toEqual(['Atrasada']);
    const todays = await http().get('/tasks?due=today').set(auth).expect(200);
    expect((todays.body as { title: string }[]).map((x) => x.title)).toEqual(['De hoy']);
    const none = await http().get('/tasks?due=none').set(auth).expect(200);
    expect((none.body as { title: string }[]).map((x) => x.title)).toEqual(['Sin fecha']);
    await http().get('/tasks?due=ayer').set(auth).expect(400);
    const mine = await http().get('/tasks/mine-count').set(auth).expect(200);
    expect(mine.body.pending).toBe(2);

    // Plan con coste y proveedor: la tarea los trae y se apunta el gasto una vez.
    const supplier = await http()
      .post('/expense-suppliers')
      .set(auth)
      .send({ name: 'Extintores Levante' })
      .expect(201);
    const plan = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Revisión de extintores',
        type: 'inspection',
        freq: 'monthly',
        dayOfMonth: 31,
        estimatedCost: 45,
        supplierId: supplier.body.id,
      })
      .expect(201);
    expect(plan.body.scheduleLabel).toBe('Cada mes, el último día');
    await http().post(`/maintenance-plans/${plan.body.id}/run`).set(auth).expect(200);
    const task = await db.task.findFirstOrThrow({ where: { maintenancePlanId: plan.body.id } });
    const detail = await http().get(`/tasks/${task.id}`).set(auth).expect(200);
    expect(detail.body).toMatchObject({ estimatedCost: 45, supplierId: supplier.body.id });

    // Fotos: subir, ver con su URL y quitar.
    const photo = await upload(`/tasks/${task.id}/photos/upload-url`, auth);
    const withPhoto = await http()
      .post(`/tasks/${task.id}/photos`)
      .set(auth)
      .send(photo)
      .expect(201);
    expect(withPhoto.body.photos).toHaveLength(1);
    expect(withPhoto.body.photos[0].url).toContain('http');
    await http()
      .post(`/tasks/${task.id}/photos`)
      .set(auth)
      .send({ ...photo, key: `otro/${photo.key}` })
      .expect(400);
    const noPhoto = await http()
      .delete(`/tasks/${task.id}/photos/${withPhoto.body.photos[0].id}`)
      .set(auth)
      .expect(200);
    expect(noPhoto.body.photos).toHaveLength(0);

    const expense = await http()
      .post(`/tasks/${task.id}/expense`)
      .set(auth)
      .send({ amount: 45 })
      .expect(201);
    expect(expense.body).toMatchObject({ amount: 45, supplierId: supplier.body.id });
    const again = await http().post(`/tasks/${task.id}/expense`).set(auth).send({ amount: 45 });
    expect(again.status).toBe(409);
    const after = await http().get(`/tasks/${task.id}`).set(auth);
    expect(after.body.expenseId).toBe(expense.body.id);
  });

  it('mantenimiento: cada 2 semanas, antelación, historial y copia a otro local', async () => {
    const { owner, auth, tenantId } = await setup('opsb-maint');
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 0 });
    const biweekly = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Limpieza a fondo',
        type: 'cleaning',
        freq: 'weekly',
        interval: 2,
        weekdays: [1],
      })
      .expect(201);
    expect(biweekly.body.scheduleLabel).toBe('Cada 2 semanas (Lun)');

    // Con 7 días de antelación, una fecha a 5 días ya crea la tarea.
    const soon = ymd(new Date(today().getTime() + 5 * DAY));
    const lead = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Revisar puertas',
        type: 'inspection',
        freq: 'daily',
        interval: 30,
        startDate: soon,
        leadDays: 7,
      })
      .expect(201);
    expect(lead.body.nextRunDate).toBe(soon);
    await app.get(MaintenanceService).generateDue();
    const created = await db.task.findMany({
      where: { tenantId, maintenancePlanId: lead.body.id },
    });
    expect(created).toHaveLength(1);
    expect(ymd(created[0]!.dueDate!)).toBe(soon);

    const history = await http()
      .get(`/maintenance-plans/${lead.body.id}/history`)
      .set(auth)
      .expect(200);
    expect(history.body).toMatchObject({ total: 1, done: 0, overdueOpen: 0 });

    const copies = await http()
      .post(`/maintenance-plans/${lead.body.id}/copy`)
      .set(auth)
      .send({ facilityIds: [other.facilityId] })
      .expect(201);
    expect(copies.body).toHaveLength(1);
    expect(copies.body[0]).toMatchObject({
      title: 'Revisar puertas',
      facilityId: other.facilityId,
      leadDays: 7,
    });
  });

  it('incidencias: tipo, plazo, fotos del inquilino, respuesta, reparación, gasto, seguro e informe', async () => {
    const { owner, auth, fac, tenantId } = await setup('opsb-inc');
    const email = `opsb-inc-${Date.now()}@e2e.local`;
    const customerId = await createCustomer(app, owner.accessToken, { email });
    // Dos trasteros: el inquilino elige de cuál es.
    const contracts: string[] = [];
    for (const unitId of fac.unitIds) {
      const c = await http()
        .post('/contracts')
        .set(auth)
        .send({ customerId, unitId, startDate: '2026-01-01', priceMonthly: 50, depositAmount: 0 })
        .expect(201);
      await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
      contracts.push(c.body.id as string);
    }

    // Plazos: crítica a 2 horas.
    await http()
      .put('/incidents/settings')
      .set(auth)
      .send({ critical: 2, high: 24, medium: 72, low: 168 })
      .expect(200);
    const fire = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Humo en el pasillo', severity: 'critical', category: 'security' })
      .expect(201);
    const due = new Date(fire.body.responseDueAt as string).getTime();
    expect(Math.abs(due - (Date.now() + 2 * 3_600_000))).toBeLessThan(60_000);
    // Fuera de plazo hasta que alguien responde.
    await db.incident.update({
      where: { id: fire.body.id },
      data: { responseDueAt: new Date(Date.now() - 60_000) },
    });
    const late = await http().get('/incidents/page?responseOverdue=1').set(auth).expect(200);
    expect((late.body.items as { id: string }[]).map((i) => i.id)).toEqual([fire.body.id]);
    await http()
      .post(`/incidents/${fire.body.id}/comments`)
      .set(auth)
      .send({ body: 'Vamos para allá' })
      .expect(201);
    const answered = await http().get(`/incidents/${fire.body.id}`).set(auth);
    expect(answered.body.firstResponseAt).toBeTruthy();
    expect(answered.body.responseOverdue).toBe(false);

    // Resolver exige decir qué se ha hecho.
    const noWhy = await http()
      .post(`/incidents/${fire.body.id}/transition`)
      .set(auth)
      .send({ status: 'resolved' })
      .expect(400);
    expect(noWhy.body.code).toBe('resolution_required');

    // Desde el área de clientes: con su trastero, tipo y foto.
    const portal = await portalLogin(owner.slug, email);
    const photo = await upload('/portal/me/incidents/photo-upload-url', portal);
    const reported = await http()
      .post('/portal/me/incidents')
      .set(portal)
      .send({ title: 'Gotera', category: 'water', contractId: contracts[1], photos: [photo] })
      .expect(201);
    expect(reported.body).toMatchObject({ category: 'water' });
    const leak = await db.incident.findUniqueOrThrow({ where: { id: reported.body.id } });
    expect(leak.contractId).toBe(contracts[1]);
    expect(leak.unitId).toBe(fac.unitIds[1]);
    expect((leak.photos as unknown[]).length).toBe(1);
    // Un contrato que no es suyo → 400.
    const stranger = await createCustomer(app, owner.accessToken);
    const foreign = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: stranger,
        unitId: fac.unitIds[0],
        startDate: '2027-06-01',
        priceMonthly: 50,
      })
      .expect(201);
    await http()
      .post('/portal/me/incidents')
      .set(portal)
      .send({ title: 'Ajena', contractId: foreign.body.id })
      .expect(400);

    // Responder al inquilino: le llega a su chat y queda en la incidencia.
    await http()
      .post(`/incidents/${leak.id}/reply`)
      .set(auth)
      .send({ body: 'Mañana viene el técnico' })
      .expect(204);
    const chat = await http().get('/portal/me/messages').set(portal).expect(200);
    const msgs = (chat.body.items ?? chat.body) as { body: string }[];
    expect(msgs.some((m) => m.body.includes('Mañana viene el técnico'))).toBe(true);
    const comments = await http().get(`/incidents/${leak.id}/comments`).set(auth);
    expect(
      (comments.body as { body: string }[]).some((c) => c.body.includes('Respuesta al inquilino')),
    ).toBe(true);

    // Tarea de reparación enlazada.
    const repair = await http().post(`/incidents/${leak.id}/task`).set(auth).send({}).expect(201);
    expect(repair.body).toMatchObject({
      unitId: fac.unitIds[1],
      metadata: { incidentId: leak.id },
    });
    const repairs = await http().get(`/incidents/${leak.id}/tasks`).set(auth).expect(200);
    expect(repairs.body).toHaveLength(1);

    // Gasto (una vez) y parte al seguro.
    const expense = await http()
      .post(`/incidents/${leak.id}/expense`)
      .set(auth)
      .send({ amount: 120 })
      .expect(201);
    await http().post(`/incidents/${leak.id}/expense`).set(auth).send({ amount: 120 }).expect(409);
    const claimed = await http()
      .patch(`/incidents/${leak.id}`)
      .set(auth)
      .send({
        insuranceClaimStatus: 'filed',
        insuranceClaimRef: 'P-2027-15',
        insuranceClaimAmount: 100,
      })
      .expect(200);
    expect(claimed.body).toMatchObject({
      cost: 120,
      expenseId: expense.body.id,
      insuranceClaimStatus: 'filed',
      insuranceClaimRef: 'P-2027-15',
      insuranceClaimAmount: 100,
    });

    const report = await http().get('/incidents/report').set(auth).expect(200);
    expect(report.body).toMatchObject({ total: 2, totalCost: 120, insuranceClaims: 1 });
    expect(
      (report.body.byCategory as { key: string; count: number }[]).find((r) => r.key === 'water'),
    ).toMatchObject({ count: 1 });
    void tenantId;
  });

  it('calendario: facturas que vencen y documentos que caducan', async () => {
    const { owner, auth, fac, tenantId } = await setup('opsb-cal', 0);
    const customerId = await createCustomer(app, owner.accessToken);
    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).send({}).expect(200);
    const due = ymd(new Date(today().getTime() + 3 * DAY));
    await db.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(`${due}T00:00:00.000Z`) },
    });
    await db.facilityDocument.create({
      data: {
        tenantId,
        facilityId: fac.facilityId,
        kind: 'insurance',
        name: 'Póliza del local',
        fileKey: `${tenantId}/docs/poliza.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        expiresOn: new Date(`${due}T00:00:00.000Z`),
      },
    });
    const from = ymd(today());
    const to = ymd(new Date(today().getTime() + 20 * DAY));
    const cal = await http().get(`/calendar?from=${from}&to=${to}`).set(auth).expect(200);
    const types = (cal.body.events as { type: string }[]).map((e) => e.type);
    expect(types).toContain('invoice_due');
    expect(types).toContain('document_expiring');
  });

  it('vencimientos: deshacer, documentos, tarea, previsión, contador y calendario con tareas', async () => {
    const { auth, tenantId } = await setup('opsb-rem', 0);
    const due = ymd(new Date(today().getTime() + 3 * DAY));
    const r = await http()
      .post('/business-reminders')
      .set(auth)
      .send({
        title: 'Seguro del local',
        category: 'insurance',
        dueDate: due,
        recurrence: 'monthly',
        amount: 100,
      })
      .expect(201);

    const count = await http().get('/business-reminders/due-count').set(auth).expect(200);
    expect(count.body.due).toBe(1);

    const forecast = await http()
      .get('/business-reminders/forecast?months=12')
      .set(auth)
      .expect(200);
    expect(forecast.body.months).toHaveLength(12);
    expect(forecast.body.total).toBeGreaterThanOrEqual(1100);

    // Hecho con gasto, y deshecho: vuelve a su fecha y el gasto se borra.
    await http()
      .post(`/business-reminders/${r.body.id}/complete`)
      .set(auth)
      .send({ registerExpense: true })
      .expect(200);
    expect(await db.expense.count({ where: { tenantId, description: 'Seguro del local' } })).toBe(
      1,
    );
    const undone = await http().post(`/business-reminders/${r.body.id}/undo`).set(auth).expect(200);
    expect(undone.body).toMatchObject({ dueDate: due, status: 'active', expenseKept: false });
    expect(await db.expense.count({ where: { tenantId, description: 'Seguro del local' } })).toBe(
      0,
    );
    await http().post(`/business-reminders/${r.body.id}/undo`).set(auth).expect(400);

    // Documentos.
    const doc = await upload(`/business-reminders/${r.body.id}/attachments/upload-url`, auth);
    const withDoc = await http()
      .post(`/business-reminders/${r.body.id}/attachments`)
      .set(auth)
      .send(doc)
      .expect(201);
    expect(withDoc.body.attachments).toHaveLength(1);
    const url = await http()
      .get(`/business-reminders/${r.body.id}/attachments/${withDoc.body.attachments[0].id}`)
      .set(auth)
      .expect(200);
    expect(url.body.url).toContain('http');

    // Como tarea (una por fecha).
    const task = await http()
      .post(`/business-reminders/${r.body.id}/task`)
      .set(auth)
      .send({})
      .expect(201);
    expect(task.body).toMatchObject({ title: 'Seguro del local', dueDate: due });
    await http().post(`/business-reminders/${r.body.id}/task`).set(auth).send({}).expect(409);

    // Calendario ICS con las tareas.
    const link = await http().post('/business-reminders/settings/calendar').set(auth).expect(201);
    const token = (link.body.icsUrl as string).split('/').pop()!;
    const plain = await http().get(`/v1/public/reminders-calendar/${token}`).expect(200);
    expect(plain.text).not.toContain('Tarea: Seguro del local');
    const withTasks = await http()
      .get(`/v1/public/reminders-calendar/${token}?include=tasks,moves`)
      .expect(200);
    expect(withTasks.text).toContain('Tarea: Seguro del local');
  });
});
