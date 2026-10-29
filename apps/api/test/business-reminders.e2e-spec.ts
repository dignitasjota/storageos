import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BusinessReminderNoticesService } from '../src/modules/business-reminders/business-reminder-notices.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { cleanupTestTenants, setTenantPlan } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/** Vencimientos del negocio: alta, avisos, hecho con gasto, plantillas y calendario. */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );

/** Un instante de hoy en que en Madrid son las 9. */
function nineInMadrid(): Date {
  const base = new Date();
  base.setUTCMinutes(10, 0, 0);
  for (let h = 0; h < 24; h += 1) {
    const d = new Date(base);
    d.setUTCHours(h);
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d);
    if (Number(local) === 9) return d;
  }
  throw new Error('sin hora');
}

describe('Vencimientos del negocio (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanupTestTenants();
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await cleanupTestTenants();
  });

  it('solo en los planes de pago; el equipo solo ve', async () => {
    const owner = await registerVerifiedUser(app, 'brfree');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    await setTenantPlan(owner.slug, 'free');
    const blocked = await http().get('/business-reminders').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('feature_not_in_plan');

    await setTenantPlan(owner.slug, 'starter');
    const created = await http()
      .post('/business-reminders')
      .set(auth)
      .send({ title: 'Renovar el dominio', category: 'domain', dueDate: isoDay(20) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ state: 'upcoming', daysLeft: 20, status: 'active' });
    expect(created.body.notifyDaysBefore).toEqual([30, 7, 1, 0]);

    const email = `br-staff-${Date.now()}@e2e.local`;
    await db.user.create({
      data: {
        tenantId: owner.tenantId,
        email,
        passwordHash: await argonHash('Secret!23'),
        fullName: 'Staff',
        role: 'staff',
        isActive: true,
        emailVerifiedAt: new Date(),
      },
    });
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Secret!23' });
    expect(login.status).toBe(200);
    const staff = { Authorization: `Bearer ${login.body.accessToken}` };
    const list = await http().get('/business-reminders').set(staff);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const denied = await http()
      .post('/business-reminders')
      .set(staff)
      .send({ title: 'Otro', category: 'other', dueDate: isoDay(5) });
    expect(denied.status).toBe(403);

    const bad = await http()
      .post('/business-reminders')
      .set(auth)
      .send({
        title: 'Sin aviso',
        category: 'other',
        dueDate: isoDay(5),
        notifyEmail: false,
        notifyInApp: false,
        notifyPush: false,
      });
    expect(bad.status).toBe(400);
  });

  it('avisa una vez por hito, marca hecho con gasto y pospone', async () => {
    const owner = await registerVerifiedUser(app, 'brnotice');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const notices = app.get(BusinessReminderNoticesService);

    const rent = await http()
      .post('/business-reminders')
      .set(auth)
      .send({
        title: 'Alquiler del local',
        category: 'rent',
        dueDate: isoDay(2),
        recurrence: 'monthly',
        notifyDaysBefore: [3, 1, 0],
        amount: 900,
        extraEmails: ['asesoria@e2e.local'],
      })
      .expect(201);

    const first = await notices.sendDue(nineInMadrid(), owner.tenantId);
    expect(first.notices).toBe(1);
    const again = await notices.sendDue(nineInMadrid(), owner.tenantId);
    expect(again.notices).toBe(0);
    const n = await db.notification.findMany({
      where: { tenantId: owner.tenantId, type: 'business_reminder.due' },
    });
    expect(n).toHaveLength(1);
    expect(n[0]!.userId).toBe(owner.userId);
    const stored = await db.businessReminderNotice.findMany({
      where: { reminderId: rent.body.id },
    });
    expect(stored.map((s) => s.kind)).toEqual(['d3']);

    // «Hoy» lo enseña (vence en 2 días).
    const today = await http().get('/dashboard/today').set(auth).expect(200);
    expect(today.body.businessRemindersDue.count).toBe(1);

    const done = await http()
      .post(`/business-reminders/${rent.body.id}/complete`)
      .set(auth)
      .send({ amount: 900, registerExpense: true, note: 'Pagado por transferencia' })
      .expect(200);
    expect(done.body.status).toBe('active');
    expect(done.body.dueDate > rent.body.dueDate).toBe(true);
    const history = await http()
      .get(`/business-reminders/${rent.body.id}/completions`)
      .set(auth)
      .expect(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0].expenseId).toBeTruthy();
    const expense = await db.expense.findUnique({ where: { id: history.body[0].expenseId } });
    expect(expense).toMatchObject({ category: 'rent', description: 'Alquiler del local' });
    const twice = await http()
      .post(`/business-reminders/${rent.body.id}/complete`)
      .set(auth)
      .send({});
    expect(twice.status).toBe(200);

    // Una sola vez → hecho; pospuesto → sin avisos hasta el día elegido.
    const once = await http()
      .post('/business-reminders')
      .set(auth)
      .send({ title: 'Revisión', category: 'inspection', dueDate: isoDay(0) })
      .expect(201);
    const snoozed = await http()
      .post(`/business-reminders/${once.body.id}/snooze`)
      .set(auth)
      .send({ days: 3 })
      .expect(200);
    expect(snoozed.body.snoozedUntil).toBe(isoDay(3));
    await notices.sendDue(nineInMadrid(), owner.tenantId);
    expect(await db.businessReminderNotice.count({ where: { reminderId: once.body.id } })).toBe(0);
    const closed = await http()
      .post(`/business-reminders/${once.body.id}/complete`)
      .set(auth)
      .send({})
      .expect(200);
    expect(closed.body.status).toBe('done');
    const repeat = await http()
      .post(`/business-reminders/${once.body.id}/complete`)
      .set(auth)
      .send({});
    expect(repeat.status).toBe(409);
  });

  it('plantillas fiscales, plazos del sistema y calendario', async () => {
    const owner = await registerVerifiedUser(app, 'brtpl');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const applied = await http()
      .post('/business-reminders/templates/fiscal_303/apply')
      .set(auth)
      .send({})
      .expect(201);
    expect(applied.body).toHaveLength(4);
    expect(
      applied.body.every((r: { templateKey: string }) => r.templateKey.startsWith('fiscal_303:')),
    ).toBe(true);
    const tpls = await http().get('/business-reminders/templates').set(auth).expect(200);
    expect(tpls.body.find((t: { key: string }) => t.key === 'fiscal_303').applied).toBe(true);
    const needsDate = await http()
      .post('/business-reminders/templates/business_domain/apply')
      .set(auth)
      .send({});
    expect(needsDate.status).toBe(400);

    await db.facility
      .create({
        data: { tenantId: owner.tenantId, name: 'Local norte' },
      })
      .then((f) =>
        db.facilityDocument.create({
          data: {
            tenantId: owner.tenantId,
            facilityId: f.id,
            kind: 'insurance',
            name: 'Seguro del local',
            fileKey: `${owner.tenantId}/x.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 10,
            expiresOn: new Date(`${isoDay(15)}T00:00:00Z`),
          },
        }),
      );
    const list = await http().get('/business-reminders').set(auth).expect(200);
    expect(
      list.body.system.some((s: { key: string }) => s.key.startsWith('facility_document:')),
    ).toBe(true);

    const settings = await http()
      .post('/business-reminders/settings/calendar')
      .set(auth)
      .expect(201);
    const token = String(settings.body.icsUrl).split('/').pop();
    const ics = await http().get(`/public/reminders-calendar/${token}`).expect(200);
    expect(ics.headers['content-type']).toContain('text/calendar');
    expect(ics.text).toContain('BEGIN:VCALENDAR');
    expect(ics.text).toContain('IVA trimestral');
    await http().delete('/business-reminders/settings/calendar').set(auth).expect(200);
    await http().get(`/public/reminders-calendar/${token}`).expect(404);

    const digest = await http()
      .patch('/business-reminders/settings')
      .set(auth)
      .send({ weeklyDigest: true })
      .expect(200);
    expect(digest.body.weeklyDigest).toBe(true);
  });
});
