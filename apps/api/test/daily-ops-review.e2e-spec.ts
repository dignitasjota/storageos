import request from 'supertest';

import { todayInTimezone } from '../src/common/format';
import { calendarAccess } from '../src/modules/calendar/calendar.service';
import { PrismaAdminService } from '../src/modules/database/prisma-admin.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { deleteAllMessages, waitForEmail } from './helpers/mailpit';
import { scopedUser } from './helpers/scoped-user';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Operaciones diarias, PR A: arreglos de tareas, incidencias, mantenimiento, calendario y vencimientos. */
describe('Operaciones diarias: arreglos (e2e)', () => {
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

  async function signed(
    auth: { Authorization: string },
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
    customer: Record<string, string> = {},
  ) {
    const customerId = await createCustomer(app, token, customer);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId,
        unitId,
        startDate: '2026-01-01',
        priceMonthly: 50,
        depositAmount: 0,
        ...body,
      })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { id: c.body.id as string, customerId };
  }

  async function portalLogin(slug: string, email: string): Promise<{ Authorization: string }> {
    await http().post('/portal/login/request').send({ tenantSlug: slug, email }).expect(204);
    const mail = await waitForEmail(email, { subjectIncludes: 'Accede' });
    const token = mail.Text.match(/token=([0-9a-f]{32}\.[A-Za-z0-9_-]+)/)?.[1];
    const consume = await http().post('/portal/login/consume').send({ token });
    return { Authorization: `Bearer ${consume.body.accessToken as string}` };
  }

  it('tareas: hecha sin pasar por «en curso», reabrir, editar y validar', async () => {
    const { owner, auth, fac } = await setup('ops-tasks');
    const other = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });

    const t = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Barrer el pasillo' })
      .expect(201);
    const done = await http()
      .post(`/tasks/${t.body.id}/transition`)
      .set(auth)
      .send({ status: 'done' })
      .expect(201);
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).toBeTruthy();

    // Reabrir quita la fecha de cierre.
    const reopened = await http()
      .post(`/tasks/${t.body.id}/transition`)
      .set(auth)
      .send({ status: 'open' })
      .expect(201);
    expect(reopened.body.status).toBe('open');
    expect(reopened.body.completedAt).toBeNull();

    // Fecha que no existe → 400.
    await http().post('/tasks').set(auth).send({ title: 'Mal', dueDate: '2027-02-31' }).expect(400);

    // Con fecha, y luego sin ella.
    const dated = await http()
      .patch(`/tasks/${t.body.id}`)
      .set(auth)
      .send({ dueDate: ymd(new Date(Date.now() + 3 * DAY)) })
      .expect(200);
    expect(dated.body.dueDate).toBeTruthy();
    const cleared = await http()
      .patch(`/tasks/${t.body.id}`)
      .set(auth)
      .send({ dueDate: null, description: null })
      .expect(200);
    expect(cleared.body.dueDate).toBeNull();

    // Un trastero de otro local no casa con el local de la tarea.
    const mismatch = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Revisar puerta', facilityId: fac.facilityId, unitId: other.unitIds[0] })
      .expect(400);
    expect(mismatch.body.code).toBe('unit_not_in_facility');
    // Solo el trastero: toma su local.
    const byUnit = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Revisar puerta', unitId: fac.unitIds[0] })
      .expect(201);
    expect(byUnit.body.facilityId).toBe(fac.facilityId);

    // Responsable que no existe o está desactivado → 400.
    const ghost = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Para nadie', assignedToUserId: '00000000-0000-4000-8000-000000000001' })
      .expect(400);
    expect(ghost.body.code).toBe('assignee_not_found');

    // Filtros mal escritos → 400, no 500.
    await http().get('/tasks/page?status=nada').set(auth).expect(400);
    await http().get('/tasks/page?facilityId=no-es-un-id').set(auth).expect(400);
  });

  it('tareas: la ronda no pierde puntos marcados a la vez y las automáticas son de toda la empresa', async () => {
    const { owner, auth, fac } = await setup('ops-round');
    const plan = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Ronda de cierre',
        type: 'inspection',
        freq: 'daily',
        interval: 1,
        checklistTemplate: [{ label: 'Puerta' }, { label: 'Luces' }, { label: 'Cámaras' }],
      })
      .expect(201);
    await http().post(`/maintenance-plans/${plan.body.id}/run`).set(auth).expect(200);
    const tasks = await http().get('/tasks').set(auth);
    const round = (tasks.body as { id: string; maintenancePlanId: string | null }[]).find(
      (x) => x.maintenancePlanId === plan.body.id,
    )!;
    const detail = await http().get(`/tasks/${round.id}`).set(auth);
    const items = detail.body.checklist as { id: string }[];
    await Promise.all(
      items.map((it) =>
        http()
          .patch(`/tasks/${round.id}/checklist/${it.id}`)
          .set(auth)
          .send({ status: 'ok' })
          .expect(200),
      ),
    );
    const after = await http().get(`/tasks/${round.id}`).set(auth);
    expect((after.body.checklist as { status: string }[]).every((it) => it.status === 'ok')).toBe(
      true,
    );

    // Las tareas automáticas: quien solo ve un local no las cambia.
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [fac.facilityId],
      tag: 'ops-rules',
    });
    const res = await http()
      .put('/tasks/auto-rules')
      .set(scoped)
      .send({
        welcomeCall: { enabled: true, days: 3 },
        moveOutInspection: { enabled: false, days: 1 },
        renewalCall: { enabled: false },
      })
      .expect(403);
    expect(res.body.code).toBe('requires_all_facilities');
  });

  it('incidencias: lo que ve el inquilino, sus datos y la ronda sin duplicar', async () => {
    const { owner, auth, fac, tenantId } = await setup('ops-inc');
    const email = `ops-inc-${Date.now()}@e2e.local`;
    const contract = await signed(auth, owner.accessToken, fac.unitIds[0]!, {}, { email });
    const portal = await portalLogin(owner.slug, email);

    // La que reporta el inquilino: visible y enlazada a su contrato.
    await http()
      .post('/portal/me/incidents')
      .set(portal)
      .send({ title: 'La puerta no cierra' })
      .expect(201);
    const fromPortal = await db.incident.findFirstOrThrow({
      where: { tenantId, title: 'La puerta no cierra' },
    });
    expect(fromPortal.visibleToCustomer).toBe(true);
    expect(fromPortal.contractId).toBe(contract.id);
    expect(fromPortal.unitId).toBe(fac.unitIds[0]);
    expect(fromPortal.facilityId).toBe(fac.facilityId);

    // Una nota interna del equipo sobre el inquilino: no la ve.
    const internal = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Sospecha de uso indebido', customerId: contract.customerId })
      .expect(201);
    expect(internal.body.visibleToCustomer).toBe(false);
    // Una avisada: la ve, con la resolución al cerrarse.
    const shared = await http()
      .post('/incidents')
      .set(auth)
      .send({
        title: 'Cambio de cerradura',
        customerId: contract.customerId,
        visibleToCustomer: true,
      })
      .expect(201);
    expect(shared.body.unitId).toBeNull();
    await http()
      .post(`/incidents/${shared.body.id}/transition`)
      .set(auth)
      .send({ status: 'resolved', resolution: 'Cerradura nueva puesta' })
      .expect(201);
    const mine = await http().get('/portal/me/incidents').set(portal).expect(200);
    const titles = (mine.body as { title: string }[]).map((i) => i.title);
    expect(titles).toContain('La puerta no cierra');
    expect(titles).toContain('Cambio de cerradura');
    expect(titles).not.toContain('Sospecha de uso indebido');
    const closed = (mine.body as { title: string; resolution: string; closedAt: string }[]).find(
      (i) => i.title === 'Cambio de cerradura',
    )!;
    expect(closed.resolution).toBe('Cerradura nueva puesta');
    expect(closed.closedAt).toBeTruthy();

    // Reabrir borra la resolución.
    const reopened = await http()
      .post(`/incidents/${shared.body.id}/transition`)
      .set(auth)
      .send({ status: 'reported' })
      .expect(201);
    expect(reopened.body.resolution).toBeNull();

    // Un contrato que no es de ese inquilino → 400.
    const strangerId = await createCustomer(app, owner.accessToken);
    const wrong = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Cruzada', customerId: strangerId, contractId: contract.id })
      .expect(400);
    expect(wrong.body.code).toBe('contract_not_for_customer');

    // El aviso abre la ficha de esa incidencia.
    await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Inundación', severity: 'critical', facilityId: fac.facilityId })
      .expect(201);
    let note: { link: string | null } | null = null;
    for (let i = 0; i < 30 && !note; i++) {
      note = await db.notification.findFirst({
        where: { tenantId, title: { contains: 'Inundación' } },
      });
      if (!note) await new Promise((r) => setTimeout(r, 100));
    }
    expect(note?.link).toMatch(/^\/incidents\?incident=[0-9a-f-]{36}$/);

    // Desde un punto de la ronda: una sola incidencia.
    const plan = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Ronda',
        type: 'inspection',
        freq: 'daily',
        interval: 1,
        checklistTemplate: [{ label: 'Extintor' }],
      })
      .expect(201);
    await http().post(`/maintenance-plans/${plan.body.id}/run`).set(auth).expect(200);
    const roundTask = await db.task.findFirstOrThrow({
      where: { tenantId, maintenancePlanId: plan.body.id },
    });
    const itemId = (roundTask.checklist as { id: string }[])[0]!.id;
    const meta = { source: 'checklist', taskId: roundTask.id, checklistItemId: itemId };
    const first = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Ronda: Extintor', metadata: meta })
      .expect(201);
    const again = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Ronda: Extintor', metadata: meta })
      .expect(409);
    expect(again.body.code).toBe('incident_already_open');
    const linked = await http().get(`/tasks/${roundTask.id}`).set(auth);
    expect(linked.body.checklist[0].incidentId).toBe(first.body.id);

    // El contador del menú cuenta solo los locales de cada uno.
    const otherFac = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 0 });
    const scoped = await scopedUser(app, owner, {
      role: 'manager',
      facilityIds: [otherFac.facilityId],
      tag: 'ops-inc-count',
    });
    const counts = await http().get('/incidents/pending-counts').set(scoped).expect(200);
    // Solo las de toda la empresa (sin local), no las del otro local.
    const companyWide = await db.incident.count({
      where: { tenantId, status: 'reported', facilityId: null, deletedAt: null },
    });
    const all = await http().get('/incidents/pending-counts').set(auth).expect(200);
    expect(counts.body.reported).toBe(companyWide);
    expect(all.body.reported).toBeGreaterThan(companyWide);
  });

  it('mantenimiento: empieza hoy, editar no mueve la fecha y «Generar ahora» crea la siguiente', async () => {
    const { auth, userId, tenantId } = await setup('ops-maint');
    const plan = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({
        title: 'Revisión mensual',
        type: 'maintenance',
        freq: 'monthly',
        interval: 1,
        dayOfMonth: 28,
        startDate: '2025-01-01',
        assignedToUserId: userId,
      })
      .expect(201);
    const todayStr = ymd(today());
    expect(plan.body.nextRunDate >= todayStr).toBe(true);
    const next = plan.body.nextRunDate as string;

    // Cambiar el título (y mandar la misma frecuencia) no mueve la fecha.
    const renamed = await http()
      .patch(`/maintenance-plans/${plan.body.id}`)
      .set(auth)
      .send({ title: 'Revisión mensual del local', freq: 'monthly', interval: 1, dayOfMonth: 28 })
      .expect(200);
    expect(renamed.body.nextRunDate).toBe(next);

    // Generar ahora: crea la tarea de esa fecha y avisa al responsable.
    const run = await http().post(`/maintenance-plans/${plan.body.id}/run`).set(auth).expect(200);
    expect(run.body).toMatchObject({ generated: true, dueDate: next });
    const task = await db.task.findFirstOrThrow({ where: { maintenancePlanId: plan.body.id } });
    expect(task.assignedToUserId).toBe(userId);
    const note = await db.notification.findFirst({
      where: { tenantId, type: 'task.assigned', userId },
    });
    expect(note?.link).toBe(`/tasks?task=${task.id}`);
    const run2 = await http().post(`/maintenance-plans/${plan.body.id}/run`).set(auth).expect(200);
    expect(run2.body).toMatchObject({ generated: false, reason: 'open_task' });

    // Pausado y reactivado con la fecha pasada: sigue desde hoy.
    await http()
      .patch(`/maintenance-plans/${plan.body.id}`)
      .set(auth)
      .send({ isActive: false })
      .expect(200);
    await db.maintenancePlan.update({
      where: { id: plan.body.id },
      data: { nextRunDate: new Date('2025-06-28T00:00:00.000Z') },
    });
    const back = await http()
      .patch(`/maintenance-plans/${plan.body.id}`)
      .set(auth)
      .send({ isActive: true })
      .expect(200);
    expect(back.body.nextRunDate >= todayStr).toBe(true);
  });

  it('calendario: permisos por tipo, prórrogas, repeticiones y tareas borradas', async () => {
    expect(calendarAccess(['tasks:read'])).toEqual({
      tasks: true,
      contracts: false,
      reservations: false,
      reminders: false,
    });

    const { owner, auth, fac } = await setup('ops-cal');
    const from = ymd(today());
    const to = ymd(new Date(today().getTime() + 27 * DAY));
    const end = ymd(new Date(today().getTime() + 10 * DAY));
    await signed(auth, owner.accessToken, fac.unitIds[0]!, { endDate: end, autoRenew: true });
    await signed(auth, owner.accessToken, fac.unitIds[1]!, { endDate: end, autoRenew: false });

    const deleted = await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Borrada', dueDate: from })
      .expect(201);
    await http().delete(`/tasks/${deleted.body.id}`).set(auth).expect(204);

    await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({ title: 'Limpieza semanal', type: 'cleaning', freq: 'weekly', weekdays: [1] })
      .expect(201);

    const cal = await http().get(`/calendar?from=${from}&to=${to}`).set(auth).expect(200);
    const events = cal.body.events as { type: string; label: string }[];
    expect(events.some((e) => e.type === 'contract_renewing')).toBe(true);
    expect(events.some((e) => e.type === 'contract_ending')).toBe(true);
    expect(events.some((e) => e.label === 'Borrada')).toBe(false);
    expect(events.filter((e) => e.label === 'Limpieza semanal').length).toBe(4);

    await http().get('/calendar?from=2027-02-30&to=2027-03-10').set(auth).expect(400);
    await http().get(`/calendar?from=${from}&to=${to}&facilityId=x`).set(auth).expect(400);
  });

  it('vencimientos: un solo «hecho», vuelve al día 31, plantilla una vez y reabrir', async () => {
    const { auth, tenantId } = await setup('ops-rem', 0);
    const r = await http()
      .post('/business-reminders')
      .set(auth)
      .send({
        title: 'Alquiler del local',
        category: 'rent',
        dueDate: '2027-01-31',
        recurrence: 'monthly',
        amount: 900,
      })
      .expect(201);

    // Dos clics a la vez: uno vale y solo hay un gasto.
    const [a, b] = await Promise.all([
      http()
        .post(`/business-reminders/${r.body.id}/complete`)
        .set(auth)
        .send({ registerExpense: true }),
      http()
        .post(`/business-reminders/${r.body.id}/complete`)
        .set(auth)
        .send({ registerExpense: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.expense.count({ where: { tenantId, description: 'Alquiler del local' } })).toBe(
      1,
    );
    const feb = await http().get(`/business-reminders/${r.body.id}`).set(auth);
    expect(feb.body.dueDate).toBe('2027-02-28');
    const mar = await http()
      .post(`/business-reminders/${r.body.id}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(mar.body.dueDate).toBe('2027-03-31');

    // Posponer y guardar otra cosa: el pospuesto se queda.
    await http()
      .post(`/business-reminders/${r.body.id}/snooze`)
      .set(auth)
      .send({ days: 3 })
      .expect(200);
    const edited = await http()
      .patch(`/business-reminders/${r.body.id}`)
      .set(auth)
      .send({ title: 'Alquiler del local (nave)' })
      .expect(200);
    expect(edited.body.snoozedUntil).toBeTruthy();

    // Una plantilla se añade una vez.
    await http()
      .post('/business-reminders/templates/fiscal_303/apply')
      .set(auth)
      .send({})
      .expect(201);
    const twice = await http()
      .post('/business-reminders/templates/fiscal_303/apply')
      .set(auth)
      .send({})
      .expect(409);
    expect(twice.body.code).toBe('template_already_applied');

    // Uno sin repetición se puede reabrir tras marcarlo hecho.
    const once = await http()
      .post('/business-reminders')
      .set(auth)
      .send({ title: 'Renovar el dominio', category: 'domain', dueDate: '2027-05-10' })
      .expect(201);
    await http().post(`/business-reminders/${once.body.id}/complete`).set(auth).send({});
    const reopened = await http()
      .patch(`/business-reminders/${once.body.id}`)
      .set(auth)
      .send({ status: 'active' })
      .expect(200);
    expect(reopened.body.status).toBe('active');

    const log = await db.auditLog.findMany({
      where: { tenantId, entityType: 'BusinessReminder' },
      select: { action: true },
    });
    const actions = log.map((l) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'business_reminder.created',
        'business_reminder.completed',
        'business_reminder.snoozed',
        'business_reminder.reopened',
      ]),
    );
  });
});
