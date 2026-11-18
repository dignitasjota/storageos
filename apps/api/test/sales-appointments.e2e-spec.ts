import { hash as argonHash } from '@node-rs/argon2';
import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { SalesAppointmentsService } from '../src/modules/admin/sales/sales-appointments.service';

import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';
import type { SalesAppointmentDto } from '@storageos/shared';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';

const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'AdminTest!23';
const EMAILS = {
  super: `appt-super-${STAMP}@storageos.local`,
  repA: `appt-a-${STAMP}@storageos.local`,
  repB: `appt-b-${STAMP}@storageos.local`,
};
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Citas del comercial: las pone él en su ficha o la dirección desde el lead; le
 * avisan al asignársela, el día antes y una hora antes. La dirección no recibe
 * avisos de citas.
 */
describe('Citas de los comerciales (e2e)', () => {
  let app: INestApplication;
  let db: PrismaClient;
  let superId: string;
  let repAId: string;
  let repBId: string;
  let superToken: string;
  let repAToken: string;
  let repBToken: string;
  const leadIds: string[] = [];

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password: PASSWORD });
    return res.body.accessToken as string;
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    const passwordHash = await argonHash(PASSWORD);
    superId = (
      await db.superAdmin.create({
        data: { email: EMAILS.super, passwordHash, fullName: 'Dirección', role: 'superadmin' },
      })
    ).id;
    repAId = (
      await db.superAdmin.create({
        data: {
          email: EMAILS.repA,
          passwordHash,
          fullName: 'Ana Citas',
          role: 'sales',
        },
      })
    ).id;
    repBId = (
      await db.superAdmin.create({
        data: {
          email: EMAILS.repB,
          passwordHash,
          fullName: 'Beto Citas',
          role: 'sales',
        },
      })
    ).id;
    app = await createTestApp();
    superToken = await login(EMAILS.super);
    repAToken = await login(EMAILS.repA);
    repBToken = await login(EMAILS.repB);
    // Sus pantallas piden la verificación en dos pasos.
    await db.superAdmin.updateMany({
      where: { id: { in: [repAId, repBId] } },
      data: { twoFactorEnabled: true },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.platformLead.deleteMany({ where: { id: { in: leadIds } } });
    await db.superAdmin.deleteMany({ where: { email: { in: Object.values(EMAILS) } } });
    await db.$disconnect();
  });

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  const inMinutes = (m: number) => new Date(Date.now() + m * MINUTE).toISOString();
  const notices = (recipientId: string) =>
    db.superAdminNotification.findMany({
      where: { recipientId, type: { startsWith: 'sales.appointment' } },
      orderBy: { createdAt: 'asc' },
    });

  async function prospect(token: string, name: string): Promise<string> {
    const res = await http()
      .post('/admin/sales/leads')
      .set(as(token))
      .send({ companyName: name, phone: `6${String(Date.now()).slice(-8)}` })
      .expect(201);
    const id = res.body.lead.id as string;
    leadIds.push(id);
    return id;
  }

  it('el comercial pone una cita en su ficha y le sale en su lista', async () => {
    const leadId = await prospect(repAToken, `Citas Ana ${STAMP}`);
    const created = await http()
      .post(`/admin/sales/accounts/${leadId}/appointments`)
      .set(as(repAToken))
      .send({
        kind: 'video',
        title: 'Demo del panel',
        startsAt: inMinutes(3 * 60),
        durationMinutes: 45,
        location: 'https://meet.example.com/abc',
      })
      .expect(201);
    const appt = created.body as SalesAppointmentDto;
    expect(appt).toMatchObject({ kind: 'video', status: 'scheduled', createdByOther: false });

    // Una cita en el pasado no se admite.
    await http()
      .post(`/admin/sales/accounts/${leadId}/appointments`)
      .set(as(repAToken))
      .send({ kind: 'call', title: 'Tarde', startsAt: inMinutes(-60) })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('appointment_in_past'));

    const list = (await http().get('/admin/sales/appointments').set(as(repAToken)).expect(200))
      .body as SalesAppointmentDto[];
    expect(list.map((a) => a.id)).toContain(appt.id);
    const ofLead = (
      await http().get(`/admin/sales/appointments?leadId=${leadId}`).set(as(repAToken)).expect(200)
    ).body as SalesAppointmentDto[];
    expect(ofLead).toHaveLength(1);

    // Otro comercial no la ve ni la toca.
    const other = (await http().get('/admin/sales/appointments').set(as(repBToken)).expect(200))
      .body as SalesAppointmentDto[];
    expect(other.map((a) => a.id)).not.toContain(appt.id);
    await http()
      .patch(`/admin/sales/appointments/${appt.id}`)
      .set(as(repBToken))
      .send({ status: 'done' })
      .expect(404);

    // Al ponérsela él mismo no hay aviso de asignación.
    expect(await notices(repAId)).toHaveLength(0);

    // Marcarla como hecha la saca de las próximas.
    await http()
      .patch(`/admin/sales/appointments/${appt.id}`)
      .set(as(repAToken))
      .send({ status: 'done' })
      .expect(200);
    const upcoming = (await http().get('/admin/sales/appointments').set(as(repAToken)).expect(200))
      .body as SalesAppointmentDto[];
    expect(upcoming.map((a) => a.id)).not.toContain(appt.id);
  });

  it('la dirección le pone una cita a un comercial: le llega el aviso y los recordatorios', async () => {
    // Un lead sin comercial: al ponerle la cita pasa a su cartera.
    const lead = await db.platformLead.create({
      data: {
        status: 'new',
        source: 'phone',
        companyName: `Lead admin ${STAMP}`,
        phone: `6${String(Date.now() + 1).slice(-8)}`,
      },
    });
    leadIds.push(lead.id);
    await http()
      .post('/admin/sales-team/appointments')
      .set(as(superToken))
      .send({ leadId: lead.id, kind: 'in_person', title: 'Visita', startsAt: inMinutes(120) })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('appointment_rep_required'));

    const startsAt = new Date(Date.now() + 30 * HOUR);
    const created = await http()
      .post('/admin/sales-team/appointments')
      .set(as(superToken))
      .send({
        leadId: lead.id,
        repId: repAId,
        kind: 'in_person',
        title: 'Visita al local',
        startsAt: startsAt.toISOString(),
        location: 'Calle Mayor 1, Madrid',
      })
      .expect(201);
    const appt = created.body as SalesAppointmentDto;
    expect(appt).toMatchObject({ repId: repAId, createdByOther: true });
    const owned = await db.platformLead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(owned.salesRepId).toBe(repAId);
    // La ve el comercial en su lista y en la ficha.
    const list = (await http().get('/admin/sales/appointments').set(as(repAToken)).expect(200))
      .body as SalesAppointmentDto[];
    expect(list.map((a) => a.id)).toContain(appt.id);

    // A otro comercial no se le puede poner una cita de un lead que no es suyo.
    await http()
      .post('/admin/sales-team/appointments')
      .set(as(superToken))
      .send({
        leadId: lead.id,
        repId: repBId,
        kind: 'call',
        title: 'Llamada',
        startsAt: inMinutes(120),
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('appointment_rep_mismatch'));

    // Aviso al asignársela, solo al comercial.
    let mine = await notices(repAId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.type).toBe('sales.appointment');
    expect(mine[0]!.link).toBe(`/admin/sales/accounts/${lead.id}`);
    expect(await notices(superId)).toHaveLength(0);
    expect(
      await db.superAdminNotification.count({
        where: { recipientId: null, type: { startsWith: 'sales.appointment' } },
      }),
    ).toBe(0);

    // El día antes (a 23 horas) y una hora antes, una vez cada uno.
    const reminders = app.get(SalesAppointmentsService);
    const dayBefore = new Date(startsAt.getTime() - 23 * HOUR);
    expect((await reminders.runReminders(dayBefore)).day).toBeGreaterThanOrEqual(1);
    await reminders.runReminders(dayBefore);
    mine = await notices(repAId);
    expect(mine).toHaveLength(2);
    expect(mine[1]!.title).toMatch(/^(Hoy|Mañana) a las \d{2}:\d{2}: cita con /);

    const hourBefore = new Date(startsAt.getTime() - 50 * MINUTE);
    await reminders.runReminders(hourBefore);
    await reminders.runReminders(hourBefore);
    mine = await notices(repAId);
    expect(mine).toHaveLength(3);
    expect(mine[2]!.title).toContain('(en 50 min)');

    // La dirección la cambia de hora: aviso y recordatorios de nuevo.
    const later = new Date(startsAt.getTime() + 48 * HOUR);
    await http()
      .patch(`/admin/sales-team/appointments/${appt.id}`)
      .set(as(superToken))
      .send({ startsAt: later.toISOString() })
      .expect(200);
    mine = await notices(repAId);
    expect(mine).toHaveLength(4);
    expect(mine[3]!.title).toContain('Cita cambiada');
    const row = await db.salesAppointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(row.dayReminderSentAt).toBeNull();
    expect(row.hourReminderSentAt).toBeNull();

    // Cancelada por la dirección: se le avisa y ya no recibe recordatorios.
    await http()
      .patch(`/admin/sales-team/appointments/${appt.id}`)
      .set(as(superToken))
      .send({ status: 'cancelled' })
      .expect(200);
    mine = await notices(repAId);
    expect(mine).toHaveLength(5);
    expect(mine[4]!.title).toContain('Cita cancelada');
    await reminders.runReminders(new Date(later.getTime() - 30 * MINUTE));
    expect(await notices(repAId)).toHaveLength(5);

    // La lista de la dirección filtra por comercial.
    const all = (
      await http()
        .get(`/admin/sales-team/appointments?repId=${repAId}&scope=all`)
        .set(as(superToken))
        .expect(200)
    ).body as SalesAppointmentDto[];
    expect(all.map((a) => a.id)).toContain(appt.id);
    expect(all.every((a) => a.repId === repAId)).toBe(true);
  });
});
