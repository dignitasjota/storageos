import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { ContractsService } from '../src/modules/contracts/contracts.service';

import { registerVerifiedUser } from './helpers/auth-flow';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de la Operativa: contratos que vencen, traslado y acceso, reservas
 * de otro inquilino, alcance por local en tareas e incidencias, borrado de
 * inquilinos, calendario, registro de accesos y planes de mantenimiento.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Revisión de la Operativa (e2e)', () => {
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

  async function signedContract(
    auth: Record<string, string>,
    token: string,
    unitId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ contractId: string; customerId: string }> {
    const customerId = await createCustomer(app, token);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId, startDate: isoDay(-400), priceMonthly: 50, ...body })
      .expect(201);
    await http().post(`/contracts/${c.body.id}/sign`).set(auth).send({}).expect(200);
    return { contractId: c.body.id, customerId };
  }

  it('un contrato que llega a su fecha se prorroga o pasa a baja', async () => {
    const owner = await registerVerifiedUser(app, 'opsrenew');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 2 });
    const renew = await signedContract(auth, owner.accessToken, unitIds[0]!, {
      endDate: isoDay(-35),
      autoRenew: true,
    });
    const stop = await signedContract(auth, owner.accessToken, unitIds[1]!, {
      endDate: isoDay(-2),
      autoRenew: false,
    });
    // La prueba fija la fecha de inicio para un plazo de 12 meses.
    await db.contract.update({
      where: { id: renew.contractId },
      data: { startDate: new Date(`${isoDay(-400)}T00:00:00Z`) },
    });

    const svc = app.get(ContractsService);
    const res = await svc.autoRenewDue();
    expect(res.renewed).toBeGreaterThanOrEqual(1);
    expect(res.ending).toBeGreaterThanOrEqual(1);

    const renewed = await db.contract.findUniqueOrThrow({ where: { id: renew.contractId } });
    expect(renewed.status).toBe('active');
    expect(renewed.endDate!.getTime()).toBeGreaterThan(Date.now());

    const ending = await db.contract.findUniqueOrThrow({ where: { id: stop.contractId } });
    expect(ending.status).toBe('ending');
    await db.tenant.update({ where: { id: owner.tenantId }, data: { autoEndContracts: true } });
    await svc.autoEndDue();
    const ended = await db.contract.findUniqueOrThrow({ where: { id: stop.contractId } });
    expect(ended.status).toBe('ended');
  });

  it('el traslado rehace el acceso y una reserva de otro inquilino bloquea la firma', async () => {
    const owner = await registerVerifiedUser(app, 'opsmove');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const { contractId, customerId } = await signedContract(auth, owner.accessToken, unitIds[0]!);

    // El PIN emitido al firmar abre su trastero.
    let cred = null;
    for (let i = 0; i < 30 && !cred; i++) {
      cred = await db.accessCredential.findFirst({ where: { customerId } });
      if (!cred) await new Promise((r) => setTimeout(r, 200));
    }
    expect(cred?.allowedUnitIds).toEqual([unitIds[0]]);

    await http()
      .post(`/contracts/${contractId}/change-unit`)
      .set(auth)
      .send({ newUnitId: unitIds[1] })
      .expect(200);
    let moved: string[] = [];
    for (let i = 0; i < 30 && moved[0] !== unitIds[1]; i++) {
      moved = (await db.accessCredential.findUniqueOrThrow({ where: { id: cred!.id } }))
        .allowedUnitIds;
      if (moved[0] !== unitIds[1]) await new Promise((r) => setTimeout(r, 200));
    }
    expect(moved).toEqual([unitIds[1]]);

    // Reserva confirmada para otro inquilino sobre el tercer trastero.
    const otherId = await createCustomer(app, owner.accessToken);
    await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId: unitIds[2],
        customerId: otherId,
        validFrom: new Date().toISOString(),
        validUntil: new Date(Date.now() + 5 * DAY).toISOString(),
        confirmImmediately: true,
      })
      .expect(201);
    const third = await createCustomer(app, owner.accessToken);
    const draft = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId: third, unitId: unitIds[2], startDate: isoDay(0), priceMonthly: 40 })
      .expect(201);
    const blocked = await http().post(`/contracts/${draft.body.id}/sign`).set(auth).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('unit_reserved_for_other');

    // Confirmar una reserva sobre un trastero ya ocupado → 409; y el precio viaja.
    const pending = await http()
      .post('/reservations')
      .set(auth)
      .send({
        unitId: unitIds[1],
        validFrom: new Date(Date.now() + 40 * DAY).toISOString(),
        validUntil: new Date(Date.now() + 45 * DAY).toISOString(),
      });
    // Un trastero ocupado no admite reservas nuevas.
    expect(pending.status).toBe(409);
    const list = await http().get('/reservations').set(auth).expect(200);
    expect(list.body[0].unitPriceMonthly).toEqual(expect.any(Number));

    // No se borra un inquilino con un contrato vivo.
    const del = await http().delete(`/customers/${customerId}`).set(auth);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('customer_has_live_contracts');
  });

  it('tareas e incidencias de otro local no se tocan y una resuelta se reabre', async () => {
    const owner = await registerVerifiedUser(app, 'opsscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'B',
      unitsCount: 1,
    });
    const taskB = await http()
      .post('/tasks')
      .set(ownerAuth)
      .send({ title: 'Revisar puerta B', facilityId: facB.facilityId })
      .expect(201);
    const incB = await http()
      .post('/incidents')
      .set(ownerAuth)
      .send({ title: 'Goteras B', facilityId: facB.facilityId })
      .expect(201);

    const email = `ops-staff-${Date.now()}@e2e.local`;
    const password = 'Passw0rd!';
    await http().post('/invitations').set(ownerAuth).send({ email, role: 'staff' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Staff A', password })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    await http()
      .patch(`/settings/users/${staff.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password })
      .expect(200);
    const staffAuth = { Authorization: `Bearer ${login.body.accessToken}` };

    expect((await http().get(`/tasks/${taskB.body.id}`).set(staffAuth)).status).toBe(403);
    expect(
      (
        await http()
          .post(`/tasks/${taskB.body.id}/transition`)
          .set(staffAuth)
          .send({ status: 'in_progress' })
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .post('/tasks')
          .set(staffAuth)
          .send({ title: 'Otra', facilityId: facB.facilityId })
      ).status,
    ).toBe(403);
    expect((await http().get(`/incidents/${incB.body.id}`).set(staffAuth)).status).toBe(403);
    // Lo de su local, sí.
    await http()
      .post('/tasks')
      .set(staffAuth)
      .send({ title: 'Ronda A', facilityId: facA.facilityId })
      .expect(201);

    // Reabrir una incidencia resuelta.
    await http()
      .post(`/incidents/${incB.body.id}/transition`)
      .set(ownerAuth)
      .send({ status: 'resolved' })
      .expect(201);
    const reopened = await http()
      .post(`/incidents/${incB.body.id}/transition`)
      .set(ownerAuth)
      .send({ status: 'reported' })
      .expect(201);
    expect(reopened.body.status).toBe('reported');
  });

  it('calendario con entradas, registro por fechas y plan editable', async () => {
    const owner = await registerVerifiedUser(app, 'opscal');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const c = await http()
      .post('/contracts')
      .set(auth)
      .send({ customerId, unitId: unitIds[0], startDate: isoDay(3), priceMonthly: 40 })
      .expect(201);
    const cal = await http()
      .get(`/calendar?from=${isoDay(0)}&to=${isoDay(10)}`)
      .set(auth)
      .expect(200);
    expect(
      (cal.body.events as { type: string; href: string }[]).some(
        (e) => e.type === 'contract_starting' && e.href === `/contracts/${c.body.id}`,
      ),
    ).toBe(true);

    const logs = await http()
      .get(`/access/logs?to=${isoDay(0)}&before=${new Date().toISOString()}`)
      .set(auth)
      .expect(200);
    expect(Array.isArray(logs.body)).toBe(true);
    expect((await http().get('/access/logs?before=nofecha').set(auth)).status).toBe(400);

    const plan = await http()
      .post('/maintenance-plans')
      .set(auth)
      .send({ title: 'Extintores', freq: 'monthly', dayOfMonth: 5 })
      .expect(201);
    const edited = await http()
      .patch(`/maintenance-plans/${plan.body.id}`)
      .set(auth)
      .send({ freq: 'weekly', weekdays: [1] })
      .expect(200);
    expect(edited.body.freq).toBe('weekly');
    expect(new Date(`${edited.body.nextRunDate}T00:00:00Z`).getUTCDay()).toBe(1);
    const bad = await http()
      .patch(`/maintenance-plans/${plan.body.id}`)
      .set(auth)
      .send({ freq: 'monthly', dayOfMonth: null });
    expect(bad.status).toBe(400);
  });
});
