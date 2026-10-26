import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { DailySummaryService } from '../src/modules/dashboard/daily-summary.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createDraftInvoice } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Funcionalidades de «Hoy»: facturas con importe para cobrar desde la bandeja,
 * «Lo mío», comparativa con el mes anterior y objetivo de ocupación, y el
 * resumen del día por correo.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );

/** Un instante de hoy en que en Madrid son las 8. */
function eightInMadrid(): Date {
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
    if (Number(local) === 8) return d;
  }
  throw new Error('sin hora');
}

describe('Funcionalidades de «Hoy» (e2e)', () => {
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

  it('facturas con importe, «Lo mío» y comparativa del mes', async () => {
    const owner = await registerVerifiedUser(app, 'todayfeat');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);

    const invoiceId = await createDraftInvoice(app, owner.accessToken, customerId);
    await http().post(`/invoices/${invoiceId}/issue`).set(auth).send({}).expect(200);
    await db.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(`${isoDay(-2)}T00:00:00Z`) },
    });

    await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Mía', dueDate: isoDay(0), assignedToUserId: owner.userId })
      .expect(201);
    await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'De nadie', dueDate: isoDay(0) })
      .expect(201);

    const all = await http().get('/dashboard/today').set(auth).expect(200);
    const overdue = all.body.invoicesOverdue.items.find((i: { id: string }) => i.id === invoiceId);
    expect(overdue.amount).toBeCloseTo(121, 2);
    expect(overdue.chargeable).toBe(false);
    expect(overdue.overdue).toBe(true);
    expect(all.body.tasksDue.count).toBe(2);

    const mine = await http().get('/dashboard/today?mine=1').set(auth).expect(200);
    expect(mine.body.tasksDue.count).toBe(1);
    expect(mine.body.tasksDue.items[0].label).toBe('Mía');
    // Los cobros no dependen de «Lo mío».
    expect(mine.body.invoicesOverdue.count).toBe(1);

    const summary = await http().get('/dashboard/today/summary').set(auth).expect(200);
    expect(summary.body.kpis.previous).toEqual(
      expect.objectContaining({ invoicedMonth: expect.any(Number), moveInsMonth: 0 }),
    );
    expect(summary.body.kpis.targetOccupancyPct).toBe(88);
    // 2 trasteros libres, objetivo 88 % → faltan 2.
    expect(summary.body.kpis.unitsToTarget).toBe(2);
  });

  it('resumen del día por correo: solo a quien lo activa y una vez al día', async () => {
    const owner = await registerVerifiedUser(app, 'todaydigest');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await http()
      .post('/tasks')
      .set(auth)
      .send({ title: 'Llamar', dueDate: isoDay(0) })
      .expect(201);
    const service = app.get(DailySummaryService);

    // Apagado por defecto.
    expect(await service.sendForTenant(owner.tenantId)).toBe(0);
    const prefs = await http().get('/me/email-notices').set(auth).expect(200);
    expect(prefs.body.notices.daily_summary).toBe(false);

    await http().patch('/me/email-notices').set(auth).send({ daily_summary: true }).expect(200);
    expect(await service.sendForTenant(owner.tenantId)).toBe(1);

    // A las 8 de Madrid se reserva el día: la segunda pasada no repite.
    const at8 = eightInMadrid();
    await service.sendDue(at8);
    const t1 = await db.tenant.findUniqueOrThrow({ where: { id: owner.tenantId } });
    expect(t1.dailySummaryLastDate).not.toBeNull();
    await db.tenant.update({
      where: { id: owner.tenantId },
      data: { staffEmailSettings: { daily_summary: false } },
    });
    // Ya enviado hoy (y además apagado para la empresa): nada.
    expect(await service.sendForTenant(owner.tenantId)).toBe(0);

    // La prueba desde el perfil llega aunque esté apagado.
    const test = await http().post('/dashboard/today/daily-summary/test').set(auth).expect(200);
    expect(test.body.sent).toBe(true);
  });
});
