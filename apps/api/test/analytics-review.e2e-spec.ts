import { PrismaClient } from '@storageos/database';
import request from 'supertest';

import { registerVerifiedUser } from './helpers/auth-flow';
import { ensureDefaultSeries } from './helpers/billing-fixtures';
import { createCustomer } from './helpers/customer-fixtures';
import { createFacilityWithUnits } from './helpers/facility-fixtures';
import { extractToken, waitForEmail } from './helpers/mailpit';
import { cleanupTestTenants } from './helpers/tenant-fixtures';
import { createTestApp } from './helpers/test-app.factory';

import type { INestApplication } from '@nestjs/common';

/**
 * Revisión de Analítica: bajas que cuentan (y las que no), embudo sin contar
 * dos veces a nadie, un solo MRR, potencial con el precio de cada trastero,
 * riesgo de baja del último año, fechas inválidas y alcance por local.
 */
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://storageos:storageos@localhost:5433/storageos?schema=public';
const DAY = 86_400_000;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('Revisión de Analítica (e2e)', () => {
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
    token: string,
    customerId: string,
    unitId: string,
    price = 50,
  ): Promise<string> {
    const c = await http()
      .post('/contracts')
      .set('Authorization', `Bearer ${token}`)
      .send({ customerId, unitId, startDate: '2025-01-01', priceMonthly: price, depositAmount: 0 });
    expect(c.status).toBe(201);
    await http()
      .post(`/contracts/${c.body.id}/sign`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    return c.body.id as string;
  }

  it('bajas: cuenta las cancelaciones de contratos en marcha y no las reservas sin pagar', async () => {
    const owner = await registerVerifiedUser(app, 'anchurn');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 4 });
    const lastMonth = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 10),
    );
    const longAgo = new Date('2025-01-01T00:00:00Z');

    // 4 contratos firmados hace tiempo: uno sigue, uno termina el mes pasado,
    // otro se cancela el mes pasado y una reserva se cancela sin pagar.
    const ids: string[] = [];
    for (const unitId of unitIds) {
      ids.push(
        await signedContract(
          owner.accessToken,
          await createCustomer(app, owner.accessToken),
          unitId,
        ),
      );
    }
    await db.contract.updateMany({ where: { id: { in: ids } }, data: { signedAt: longAgo } });
    await db.contract.update({
      where: { id: ids[1]! },
      data: { status: 'ended', endedAt: lastMonth },
    });
    await db.contract.update({
      where: { id: ids[2]! },
      data: { status: 'cancelled', cancelledAt: lastMonth },
    });
    await db.contract.update({
      where: { id: ids[3]! },
      data: { status: 'cancelled', cancelledAt: lastMonth, firstPaymentDeadline: lastMonth },
    });
    // Un borrador sin firmar no cuenta como activo.
    await http()
      .post('/contracts')
      .set(auth)
      .send({
        customerId: await createCustomer(app, owner.accessToken),
        unitId: unitIds[0],
        startDate: '2025-01-01',
        priceMonthly: 50,
        depositAmount: 0,
      })
      .expect(201);

    const churn = await http().get('/analytics/churn').set(auth).expect(200);
    expect(churn.body.months).toHaveLength(12);
    const row = churn.body.months.find(
      (m: { yearMonth: string }) => m.yearMonth === monthKey(lastMonth),
    );
    expect(row).toMatchObject({ activeAtStart: 3, ended: 2 });

    // Rango enorme: se acota a 36 meses.
    const capped = await http()
      .get('/analytics/churn?from=2000-01&to=2026-10')
      .set(auth)
      .expect(200);
    expect(capped.body.months.length).toBeLessThanOrEqual(36);
    // Fechas mal formadas: 400, no 500.
    const bad = await http().get('/analytics/churn?from=2026-13&to=2026-10').set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_date');
    await http().get('/analytics/aging?atDate=ayer').set(auth).expect(400);
    await http().get('/analytics/leads-funnel?from=2026-02-31').set(auth).expect(400);
  });

  it('embudo: cada contacto cuenta una vez', async () => {
    const owner = await registerVerifiedUser(app, 'anfunnel');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const mk = async (name: string) =>
      (
        await http()
          .post('/leads')
          .set(auth)
          .send({ firstName: name, source: 'manual' })
          .expect(201)
      ).body.id as string;
    const a = await mk('Nuevo');
    const b = await mk('Contactado');
    const c = await mk('Cualificado');
    await mk('Otro nuevo');
    void a;
    await db.lead.update({
      where: { id: b },
      data: { status: 'contacted', contactedAt: new Date() },
    });
    await db.lead.update({
      where: { id: c },
      data: { status: 'qualified', contactedAt: new Date(), qualifiedAt: new Date() },
    });

    const res = await http().get('/analytics/leads-funnel').set(auth).expect(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totals).toMatchObject({ new: 2, contacted: 1, qualified: 1, won: 0 });
    expect(res.body.reached).toMatchObject({ contacted: 2, qualified: 1 });
    expect(res.body.conversion.newToContacted).toBeCloseTo(0.5);
  });

  it('un solo MRR, potencial con el precio de cada trastero y morosidad sin fianzas', async () => {
    const owner = await registerVerifiedUser(app, 'anmrr');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 3 });
    const contractId = await signedContract(
      owner.accessToken,
      await createCustomer(app, owner.accessToken),
      unitIds[0]!,
      80,
    );
    await db.contract.update({ where: { id: contractId }, data: { discountAmount: 10 } });
    await db.unit.update({ where: { id: unitIds[1]! }, data: { basePriceMonthly: 70 } });
    await db.unit.update({ where: { id: unitIds[2]! }, data: { status: 'maintenance' } });

    const occ = await http().get('/analytics/occupancy').set(auth).expect(200);
    const rev = await http().get('/analytics/revenue').set(auth).expect(200);
    const forecast = await http().get('/analytics/forecast').set(auth).expect(200);
    expect(occ.body.mrrActual).toBe(70);
    expect(rev.body.mrr).toBe(70);
    expect(forecast.body.current.mrr).toBe(70);
    // Potencial = 50 (ocupado, su precio de catálogo) + 70; el de mantenimiento no cuenta.
    expect(occ.body.mrrPotential).toBe(120);
    expect(occ.body.outOfServiceUnits).toBe(1);
    expect(occ.body.perFacility[0]).toMatchObject({ occupied: 1, available: 1, outOfService: 1 });

    // Un justificante de fianza vencido no es deuda del alquiler.
    const customerId = await createCustomer(app, owner.accessToken);
    await db.invoice.create({
      data: {
        tenantId: owner.tenantId,
        seriesId: await ensureDefaultSeries(app, owner.accessToken),
        sequenceNumber: 0,
        customerId,
        kind: 'deposit_receipt',
        invoiceNumber: `FZ-test-${Date.now()}`,
        status: 'overdue',
        issueDate: new Date(Date.now() - 40 * DAY),
        dueDate: new Date(Date.now() - 35 * DAY),
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    const aging = await http().get('/analytics/aging').set(auth).expect(200);
    expect(aging.body.totalOutstanding).toBe(0);
  });

  it('riesgo de baja: olvida lo de hace más de un año y cuenta el mandato SEPA', async () => {
    const owner = await registerVerifiedUser(app, 'anrisk');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const { unitIds } = await createFacilityWithUnits(app, owner.accessToken, { unitsCount: 1 });
    const customerId = await createCustomer(app, owner.accessToken);
    const contractId = await signedContract(owner.accessToken, customerId, unitIds[0]!);
    // Un cobro fallido de hace dos años.
    const invoice = await db.invoice.create({
      data: {
        tenantId: owner.tenantId,
        seriesId: await ensureDefaultSeries(app, owner.accessToken),
        sequenceNumber: 0,
        customerId,
        contractId,
        invoiceNumber: `OLD-${Date.now()}`,
        status: 'paid',
        issueDate: new Date(Date.now() - 730 * DAY),
        subtotal: 50,
        taxAmount: 0,
        total: 50,
        amountPaid: 50,
      },
    });
    await db.payment.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        invoiceId: invoice.id,
        amount: 50,
        currency: 'EUR',
        status: 'failed',
        methodType: 'card',
        gateway: 'manual',
        createdAt: new Date(Date.now() - 730 * DAY),
      },
    });
    // Paga por la remesa SEPA del negocio.
    await db.sepaMandate.create({
      data: {
        tenantId: owner.tenantId,
        customerId,
        reference: `MND-${Date.now()}`,
        ibanEncrypted: 'x',
        ibanLast4: '1332',
        signedAt: new Date(),
        status: 'active',
        signatureStatus: 'external',
      },
    });

    const risk = await http().get('/analytics/churn-risk').set(auth).expect(200);
    expect(risk.body.summary.low).toBe(1);
    expect(risk.body.items).toHaveLength(0);
  });

  it('un usuario de un local solo ve los datos de su local y no cambia precios de otros', async () => {
    const owner = await registerVerifiedUser(app, 'anscope');
    const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` };
    const facA = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local A',
      typeName: 'Tipo A',
      unitsCount: 1,
    });
    const facB = await createFacilityWithUnits(app, owner.accessToken, {
      facilityName: 'Local B',
      typeName: 'Tipo B',
      unitsCount: 2,
    });
    await signedContract(
      owner.accessToken,
      await createCustomer(app, owner.accessToken),
      facB.unitIds[0]!,
      90,
    );

    const email = `an-staff-${Date.now()}@e2e.local`;
    await http().post('/invitations').set(ownerAuth).send({ email, role: 'manager' }).expect(201);
    const mail = await waitForEmail(email, { subjectIncludes: 'invitado' });
    await http()
      .post(`/invitations/token/${extractToken(mail.Text, '/invite')}/accept`)
      .send({ fullName: 'Gestor A', password: 'Passw0rd!' })
      .expect(200);
    const users = await http().get('/users').set(ownerAuth);
    const staff = (users.body as { id: string; email: string }[]).find((u) => u.email === email)!;
    // Rol propio con permiso para cambiar precios (el gestor no lo tiene).
    const role = await http()
      .post('/settings/roles')
      .set(ownerAuth)
      .send({
        name: 'Precios',
        permissions: ['analytics:read', 'units:read', 'units:manage'],
        baseRole: 'manager',
      })
      .expect(201);
    await http()
      .patch(`/settings/users/${staff.id}/tenant-role`)
      .set(ownerAuth)
      .send({ tenantRoleId: role.body.id })
      .expect(204);
    await http()
      .patch(`/settings/users/${staff.id}/facilities`)
      .set(ownerAuth)
      .send({ facilityIds: [facA.facilityId] })
      .expect(204);
    const login = await http()
      .post('/auth/login')
      .send({ tenantSlug: owner.slug, email, password: 'Passw0rd!' });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const rev = await http().get('/analytics/revenue').set(auth).expect(200);
    expect(rev.body).toMatchObject({ mrr: 0, totalUnits: 1 });
    const risk = await http().get('/analytics/churn-risk').set(auth).expect(200);
    expect(risk.body.summary.total).toBe(0);
    // Pedir el local B a mano tampoco da sus datos.
    const occB = await http().get(`/analytics/occupancy?facilityId=${facB.facilityId}`).set(auth);
    expect(occB.body.totalUnits).toBe(0);
    // El dueño, filtrando por B, sí los ve.
    const ownerB = await http()
      .get(`/analytics/revenue?facilityId=${facB.facilityId}`)
      .set(ownerAuth)
      .expect(200);
    expect(ownerB.body).toMatchObject({ mrr: 90, totalUnits: 2 });

    // No puede cambiar el precio de un trastero de B ni el de un tipo (vale para todos).
    await http()
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId: facB.unitIds[1], price: 99 })
      .expect(404);
    await http()
      .post('/analytics/pricing-suggestions/apply')
      .set(auth)
      .send({ unitTypeId: facA.unitTypeId, price: 99 })
      .expect(403);
    await http()
      .post('/analytics/unit-pricing-suggestions/apply')
      .set(auth)
      .send({ unitId: facA.unitIds[0], price: 61 })
      .expect(201);
  });
});
