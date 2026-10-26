import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { BillingJobsService } from '../src/modules/billing/billing-jobs.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Funcionalidades de la Operativa: entrada y salida, traslado desde la
 * solicitud, asignación con aviso, tareas automáticas, contexto de una
 * incidencia, señal de reserva, autorizados, informe de accesos y la puerta.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
// Día de calendario en la zona del local de prueba (Europe/Madrid): entre las
// 00:00 y las 02:00 el día UTC va por detrás y «hoy» no casaría.
const isoDay = (offset: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
    new Date(Date.now() + offset * DAY),
  );
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Funcionalidades de la Operativa (e2e)', () => {
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

  it('entrada y salida, traslado desde la solicitud y contexto de la incidencia', async () => {
    const owner = await registerVerifiedUser(app, 'opfmove');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(-10), priceMonthly: 40 })
      .expect(201);

    const before = await http().get(`/contracts/${c.body.id}/checklist`).set(auth).expect(200);
    expect(before.body.moveIn.find((s: { key: string }) => s.key === 'signed').done).toBe(false);
    expect(before.body.moveOut).toBeNull();

    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    const after = await http().get(`/contracts/${c.body.id}/checklist`).set(auth).expect(200);
    expect(after.body.moveIn.find((s: { key: string }) => s.key === 'signed').done).toBe(true);

    // Solicitud de cambio → traslado directo.
    const req = await db.unitChangeRequest.create({
      data: { tenantId: owner.tenantId, customerId, contractId: c.body.id, note: 'Más grande' },
    });
    const moved = await http()
      .post(`/unit-change-requests/${req.id}/move`)
      .set(auth)
      .send({ newUnitId: unitIds[1] })
      .expect(200);
    expect(moved.body.status).toBe('handled');
    const contract = await db.contract.findUniqueOrThrow({ where: { id: c.body.id } });
    expect(contract.unitId).toBe(unitIds[1]);
    // Ya resuelta, no se traslada otra vez.
    const again = await http()
      .post(`/unit-change-requests/${req.id}/move`)
      .set(auth)
      .send({ newUnitId: unitIds[0] });
    expect(again.status).toBe(400);

    // Contexto de una incidencia del trastero: el contrato que lo ocupa.
    const inc = await http()
      .post('/incidents')
      .set(auth)
      .send({ title: 'Puerta forzada', unitId: unitIds[1] })
      .expect(201);
    const ctx = await http().get(`/incidents/${inc.body.id}/context`).set(auth).expect(200);
    expect(ctx.body.unit.id).toBe(unitIds[1]);
    expect(ctx.body.contracts[0]).toMatchObject({ id: c.body.id, customerId });
  });

  it('asignación con aviso, tareas automáticas y autorizados', async () => {
    const owner = await registerVerifiedUser(app, 'opftasks');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const email = `opf-staff-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(auth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Staff Uno', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(auth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' })
      .expect(200);
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    const t1 = await http().post('/tasks').set(auth).send({ title: 'Limpiar pasillo' }).expect(201);
    const t2 = await http().post('/tasks').set(auth).send({ title: 'Revisar luces' }).expect(201);
    const bulk = await http()
      .post('/tasks/bulk-assign')
      .set(auth)
      .send({ taskIds: [t1.body.id, t2.body.id], assignedToUserId: staff.id })
      .expect(200);
    expect(bulk.body.updated).toBe(2);
    let staffNotes: { items: { type: string }[] } = { items: [] };
    for (let i = 0; i < 20 && !staffNotes.items.some((n) => n.type === 'task.assigned'); i++) {
      staffNotes = (await http().get('/notifications').set(staffAuth)).body;
      if (!staffNotes.items.some((n) => n.type === 'task.assigned')) await wait(150);
    }
    expect(staffNotes.items.some((n) => n.type === 'task.assigned')).toBe(true);
    // El aviso es solo para ella: el propietario no lo ve.
    const ownerNotes = await http().get('/notifications').set(auth);
    expect(
      (ownerNotes.body.items as { type: string }[]).some((n) => n.type === 'task.assigned'),
    ).toBe(false);

    // Tareas automáticas: llamada de bienvenida al firmar.
    await http()
      .put('/tasks/auto-rules')
      .set(auth)
      .send({
        welcomeCall: { enabled: true, days: 2 },
        moveOutInspection: { enabled: true, days: 1 },
        renewalCall: { enabled: false },
      })
      .expect(200);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(0), priceMonthly: 30 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    let welcome = null;
    for (let i = 0; i < 20 && !welcome; i++) {
      welcome = await db.task.findFirst({
        where: { tenantId: owner.tenantId, title: { startsWith: 'Llamada de bienvenida' } },
      });
      if (!welcome) await wait(150);
    }
    expect(welcome?.dueDate?.toISOString().slice(0, 10)).toBe(isoDay(2));

    // Autorizados del inquilino.
    const ap = await http()
      .post(`/customers/${customerId}/authorized-persons`)
      .set(auth)
      .send({ fullName: 'Luis Pérez', relationship: 'Hermano', canPickup: true })
      .expect(201);
    expect(ap.body).toMatchObject({ canAccess: true, canPickup: true, canManage: false });
    await http()
      .patch(`/customers/${customerId}/authorized-persons/${ap.body.id}`)
      .set(auth)
      .send({ fullName: 'Luis Pérez', canAccess: false })
      .expect(200);
    const list = await http().get(`/customers/${customerId}/authorized-persons`).set(auth);
    expect(list.body[0].canAccess).toBe(false);
    await http()
      .delete(`/customers/${customerId}/authorized-persons/${ap.body.id}`)
      .set(auth)
      .expect(204);
  });

  it('la señal de la reserva se cobra y se descuenta del contrato', async () => {
    const owner = await registerVerifiedUser(app, 'opfsignal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    await ensureDefaultSeries(app, owner.accessToken);
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const r = await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId: unitIds[0],
        customerId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        depositAmount: 20,
      })
      .expect(201);
    const confirmed = await http().post(`/reservations/${r.body.id}/confirm`).set(auth).expect(200);
    expect(confirmed.body.depositInvoiceId).toBeTruthy();
    const inv = await http().get(`/invoices/${confirmed.body.depositInvoiceId}`).set(auth);
    expect(inv.body.status).toBe('issued');
    expect(Number(inv.body.total)).toBeCloseTo(24.2, 2);
    // Idempotente.
    const again = await http()
      .post(`/reservations/${r.body.id}/deposit-invoice`)
      .set(auth)
      .expect(200);
    expect(again.body.depositInvoiceId).toBe(confirmed.body.depositInvoiceId);

    await http()
      .post(`/invoices/${inv.body.id}/mark-paid`)
      .set(auth)
      .send({ amount: 24.2, methodType: 'cash' })
      .expect(200);
    let paid = false;
    for (let i = 0; i < 20 && !paid; i++) {
      paid = (await db.reservation.findUniqueOrThrow({ where: { id: r.body.id } })).depositPaid;
      if (!paid) await wait(150);
    }
    expect(paid).toBe(true);

    const contract = await http()
      .post(`/reservations/${r.body.id}/convert-to-contract`)
      .set(auth)
      .send({ startDate: '2026-06-01', priceMonthly: 50 })
      .expect(200);
    const row = await db.contract.findUniqueOrThrow({ where: { id: contract.body.id } });
    expect(Number(row.pendingCreditAmount)).toBe(20);
    await http().post(`/contracts/${contract.body.id}/sign`).set(auth).send({}).expect(200);

    await app.get(BillingJobsService).processGenerateRecurring({
      tenantId: owner.tenantId,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    });
    const first = await db.invoice.findFirst({
      where: { contractId: contract.body.id, kind: 'invoice' },
      include: { items: true },
    });
    const rent = first!.items[0]!;
    expect(Number(rent.unitPrice)).toBe(30);
    expect(rent.description).toContain('descontados 20,00 €');
    const done = await db.contract.findUniqueOrThrow({ where: { id: contract.body.id } });
    expect(Number(done.pendingCreditAmount)).toBe(0);
  });

  it('informe de accesos y vista de la puerta con PIN de visita', async () => {
    const owner = await registerVerifiedUser(app, 'opfdoor');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { facilityId, unitIds } = await createFacilityWithUnits(app, owner.accessToken, {
      unitsCount: 1,
    });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(0), priceMonthly: 30 })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);

    const view = await http().get(`/access/door?facilityId=${facilityId}`).set(auth).expect(200);
    expect(view.body.facility.id).toBe(facilityId);
    expect(view.body.moveIns.map((p: { contractId: string }) => p.contractId)).toContain(c.body.id);

    const pin = await http()
      .post('/access/door/visitor-pin')
      .set(auth)
      .send({ customerId, facilityId, label: 'Mudanzas' })
      .expect(201);
    expect(pin.body.pin).toMatch(/^\d{6,8}$/);
    const cred = await db.accessCredential.findUniqueOrThrow({
      where: { id: pin.body.credentialId },
    });
    expect(cred.maxUses).toBe(1);
    expect(cred.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(cred.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DAY + 3_600_000);

    const report = await http().get('/access/logs/report?days=7').set(auth).expect(200);
    expect(report.body.days).toBe(7);
    expect(report.body.byDay).toHaveLength(7);
    expect(report.body.byHour).toHaveLength(24);
  });
});
